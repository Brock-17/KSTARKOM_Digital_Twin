"""
main.py
--------
The FastAPI application. Run this file to start the whole system:

    python backend/main.py

It will:
  1. Load your real trained model (model_service.load()).
  2. Run a quick self-test prediction so problems show up immediately.
  3. Start the background sensor simulator (no hardware needed).
  4. Serve the REST API AND the frontend dashboard, both from one process,
     so you only need one command to run everything.

Open http://127.0.0.1:8000 in your browser after starting this.
"""

import os
import sys

# Allow "python backend/main.py" to work from the project root by making
# sure this folder is on the import path (needed for `import config`, etc.)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware

import config
from schemas import SensorReading, PredictionResponse, SimulatorModeRequest, VisionJointUpdate
from feature_engineering import SensorHistory
from model_service import model_service
from digital_twin import digital_twin
from simulator import simulator

app = FastAPI(title="K'STARKOM Digital Twin Backend")

# Allow the frontend (served from the same origin, but CORS is harmless
# to enable in case you open the frontend separately during development)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Shared sensor history buffer used by both /api/predict and the simulator
sensor_history = SensorHistory()


# ---------------------------------------------------------------------------
# Core prediction pipeline -- used by both the manual /api/predict endpoint
# and the automatic background simulator loop.
# ---------------------------------------------------------------------------
def run_prediction_pipeline(sensor_values: dict) -> dict:
    sensor_history.add_reading(
        speed=sensor_values["speed"],
        load=sensor_values["load"],
        temperature=sensor_values["temperature"],
        vibration=sensor_values["vibration"],
        current=sensor_values["current"],
    )
    feature_row = sensor_history.build_feature_vector()
    prediction = model_service.predict(feature_row)
    digital_twin.update_from_prediction(sensor_values, prediction)
    return prediction


def _simulator_tick(reading: dict):
    """Called automatically by the background simulator thread."""
    run_prediction_pipeline(reading)


# ---------------------------------------------------------------------------
# Startup: load model, self-test, start simulator
# ---------------------------------------------------------------------------
@app.on_event("startup")
def startup_event():
    print("=" * 70)
    print("K'STARKOM Digital Twin backend starting up...")
    print("=" * 70)

    # 1. Load the real trained model
    model_service.load()

    # 2. Self-test: feed a few synthetic readings through the FULL pipeline
    #    (history -> feature engineering -> scaler -> model) to confirm
    #    everything works end-to-end before we call this "ready".
    print("[startup] Running self-test predictions...")
    test_readings = [
        {"speed": 120, "load": 500, "temperature": 42, "vibration": 1.8, "current": 8.4},
        {"speed": 121, "load": 505, "temperature": 42, "vibration": 1.9, "current": 8.5},
        {"speed": 119, "load": 495, "temperature": 41, "vibration": 1.7, "current": 8.3},
    ]
    for reading in test_readings:
        result = run_prediction_pipeline(reading)
    print(f"[startup] Self-test OK. Sample prediction: {result}")
    print("=" * 70)

    # 3. Start the background simulator so the dashboard has live data
    #    immediately, without the user needing to press anything.
    simulator.start_background_loop(_simulator_tick)
    print("[startup] Background simulator started (NORMAL mode).")
    print("[startup] Backend ready. Open http://127.0.0.1:8000 in your browser.")


# ---------------------------------------------------------------------------
# API: health / model info
# ---------------------------------------------------------------------------
@app.get("/api/health")
def get_health():
    return {"status": "online", "model_loaded": model_service.loaded}


@app.get("/api/model")
def get_model_info():
    if not model_service.loaded:
        raise HTTPException(status_code=503, detail="Model not loaded yet")
    return model_service.get_model_info()


# ---------------------------------------------------------------------------
# API: digital twin state / current sensors
# ---------------------------------------------------------------------------
@app.get("/api/conveyor")
def get_conveyor_state():
    return digital_twin.to_state_dict()


@app.get("/api/sensors")
def get_current_sensors():
    if not sensor_history.has_data():
        raise HTTPException(status_code=404, detail="No sensor readings yet")
    latest = sensor_history.readings[-1]
    return {
        "timestamp": latest["timestamp"],
        "speed": latest["Speed (rpm)"],
        "load": latest["Load (kg)"],
        "temperature": latest["Temperature (℃)"],
        "vibration": latest["Vibration (m/s²)"],
        "current": latest["Current (A)"],
    }


@app.get("/api/sensors/history")
def get_sensor_history(n: int = 50):
    """Recent readings for the frontend's live charts."""
    readings = sensor_history.recent_for_charts(n)
    return [
        {
            "timestamp": r["timestamp"],
            "speed": r["Speed (rpm)"],
            "load": r["Load (kg)"],
            "temperature": r["Temperature (℃)"],
            "vibration": r["Vibration (m/s²)"],
            "current": r["Current (A)"],
        }
        for r in readings
    ]


# ---------------------------------------------------------------------------
# API: manual prediction (e.g. testing a specific hypothetical reading)
# ---------------------------------------------------------------------------
@app.post("/api/predict", response_model=PredictionResponse)
def predict(reading: SensorReading):
    sensor_values = reading.dict()
    try:
        prediction = run_prediction_pipeline(sensor_values)
    except Exception as e:
        # Do not hide feature-mismatch or model errors -- surface them clearly.
        raise HTTPException(status_code=500, detail=f"Prediction failed: {e}")
    return prediction


# ---------------------------------------------------------------------------
# API: simulator control
# ---------------------------------------------------------------------------
@app.get("/api/simulator")
def get_simulator_status():
    return simulator.get_status()


@app.post("/api/simulator/mode")
def set_simulator_mode(request: SimulatorModeRequest):
    try:
        simulator.set_mode(request.mode)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return simulator.get_status()


# ---------------------------------------------------------------------------
# API: FUTURE extension point for AI-vision joint damage detection.
# Not connected to a real computer-vision model in this prototype -- this
# just shows how one could push updates into the Digital Twin later.
# ---------------------------------------------------------------------------
@app.post("/api/vision/joint")
def update_joint_from_vision(update: VisionJointUpdate):
    try:
        digital_twin.update_joint_from_vision(
            update.joint_id, update.damage_type, update.severity
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return digital_twin.joints[update.joint_id]


# ---------------------------------------------------------------------------
# Serve the frontend dashboard from this same backend process, so the
# whole project runs with a single command: python backend/main.py
# ---------------------------------------------------------------------------
app.mount("/static", StaticFiles(directory=config.FRONTEND_DIR), name="static")


@app.get("/")
def serve_dashboard():
    return FileResponse(os.path.join(config.FRONTEND_DIR, "index.html"))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)

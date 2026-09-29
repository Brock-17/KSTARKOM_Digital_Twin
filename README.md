# K'STARKOM — Intelligent Conveyor Monitoring (Digital Twin & Predictive Maintenance Prototype)

SIH 2026 project: **Intelligent Monitoring and Prediction of Conveyor Belt
Joint Rupture and Damages in Iron Ore Mining Industry.**

This prototype loads YOUR actual trained model
(`predictive_maintenance_pipeline.pkl`), runs it behind a FastAPI backend,
feeds it simulated sensor data (no hardware needed yet), and displays
everything on a live web dashboard styled like an industrial SCADA system.

---

## 1. What's actually real here, and what's simulated

Being upfront about this matters for a judged prototype:

| Part                                             | Real or simulated?                                   |
|---------------------------------------------------|-------------------------------------------------------|
| The ML model (`predictive_maintenance_pipeline.pkl`) | **Real.** Your trained XGBoost pipeline, loaded and run as-is. Not retrained, not replaced. |
| Feature engineering (rolling mean/std, rate of change) | **Real**, computed from a live in-memory sensor history buffer, matching your training config (window = 5). |
| Sensor data (speed/load/temperature/vibration/current) | **Simulated.** No ESP32/MQTT hardware is connected yet -- see Section 6 for how to plug that in later. |
| Overall health / risk / predicted fault           | **Derived from the real model's output** (see Section 3 for an important caveat about how "risk" is computed). |
| Individual belt joints (J1-J5) and components (motor, pulleys, idlers, bearings) | **Simulated.** There's no camera/vision system yet. `POST /api/vision/joint` is a ready-made extension point for a future YOLO-based damage detector. |

---

## 2. What we found when we inspected your model (before writing any code)

We loaded `predictive_maintenance_pipeline.pkl` directly and printed its
contents rather than assuming its structure. It is a **plain Python dict**
(not a scikit-learn `Pipeline` object), containing:

```python
{
    "model": XGBClassifier,          # trained 6-class classifier
    "scaler": StandardScaler,        # fit on the 20 training features
    "feature_cols": [...20 names...],# EXACT column order the model needs
    "label_encoders": {"Fault": LabelEncoder},
    "target_col": "Fault",
    "model_type": "XGBoost",
}
```

Both `.predict()` and `.predict_proba()` work on the XGBClassifier. The
backend (`model_service.py`) uses `predict_proba()` to get real class
probabilities, and takes the highest one as "confidence."

### Verified fault class names

We printed `label_encoders['Fault'].classes_` directly from your pickle.
scikit-learn's `LabelEncoder` sorts class labels alphabetically, so the
mapping from the model's numeric output to the original label is:

| Numeric class | Trained label (from your data) | Display name used in the UI |
|---|---|---|
| 0 | `ball bearing` | Ball Bearing Fault |
| 1 | `belt slippage` | Belt Slippage |
| 2 | `central shaft` | Central Shaft Fault |
| 3 | `drive motor` | Drive Motor Fault |
| 4 | `idler roller fault` | Idler Roller Fault |
| 5 | `pulley` | Pulley Fault |

This mapping lives in one place: `backend/config.py` (`FAULT_CLASS_NAMES`),
so you can edit display names any time.

### ⚠️ Important, honest caveat: there is no "Normal" class

**None of the six trained classes represent normal, healthy operation.**
All six are fault/condition categories. This means the model always
classifies a reading as one of six fault *types* — it does not have a
learned notion of "no fault." We could not find evidence of a "normal"
label anywhere in the pickle, `model_metadata.json`, or `feature_config.json`.

Because of this, the originally-planned risk formula
(`risk = 1 - probability_of_normal_class`) **cannot be used** — there's no
verified "normal" class to take that probability from. Instead, per your
own fallback instruction, the backend computes:

```
risk = 1 - confidence
```

...and labels this everywhere as a **prototype risk indicator**, not a
validated safety metric. `class_probabilities` and `risk_method` are
included in every prediction response so this is always transparent.

**Please read this next part carefully** — it's a real limitation, not
just a disclaimer: because "confidence" measures *how sure the model is
about which fault type it is*, not *whether a fault exists at all*, a
very confident prediction of, say, "Pulley Fault" currently produces a
**low** risk score (since confidence is high). That's counter-intuitive
for a maintenance system and is a direct consequence of there being no
"normal" class. If you have access to your original training notebook or
raw dataset, it's worth checking whether one of the six classes (perhaps
`belt slippage`, which is arguably the mildest of the six) was actually
meant to represent low-risk/normal operation. If you confirm this, tell
me which class it is and I'll switch `NORMAL_CLASS_INDEX` in
`backend/config.py` to the verified probability-of-normal formula in one
line.

### Simulator ranges were recalibrated to your model's real training data

We also inspected `scaler.mean_` / `scaler.scale_` inside your pickle to
see what sensor ranges the model actually learned from:

| Feature | Training mean | Training std |
|---|---|---|
| Speed (rpm) | 120.8 | 4.6 |
| Load (kg) | 506.7 | 18.4 |
| Temperature (°C) | 41.6 | 3.2 |
| Vibration (m/s²) | 0.86 | 0.13 |
| Current (A) | 3.43 | 0.23 |

These are noticeably narrower (especially vibration and current) than the
illustrative ranges in the original brief (e.g. 1–3 m/s² vibration, 5–12A
current). Feeding the model data that far outside its training
distribution made it extrapolate and predict the same fault with
artificially high confidence almost regardless of simulator mode — not a
useful demo. So `NORMAL_RANGES` in `backend/config.py` is calibrated to
roughly mean ± 2 std of the real training data, with WARNING/FAULT modes
pushing further from there. This was verified to produce clearly
different, high-confidence predictions across simulated conditions (see
comments in `config.py` and `simulator.py` for the reasoning, and edit
those ranges if you have better domain knowledge).

---

## 3. Architecture

```
Sensor Simulator (no hardware needed)
        │  new reading every ~1.5s
        ▼
FastAPI Backend (backend/main.py)
        │
        ▼
Sensor History Buffer (feature_engineering.py)
        │  rolling mean / rolling std / rate of change
        ▼
Feature Vector (20 features, exact order from your pickle)
        │
        ▼
Your Trained XGBoost Pipeline (model_service.py)
        │  predict() + predict_proba()
        ▼
Fault Prediction + Confidence
        │
        ▼
Risk / Health Score (transparent formula, see Section 2)
        │
        ▼
Digital Twin State (digital_twin.py)
        │
        ▼
Web Dashboard (frontend/) — polls the API every 1.5s, no page reloads
```

---

## 4. Project structure

```
KSTARKOM_Digital_Twin/
│
├── backend/
│   ├── main.py                 FastAPI app + all REST endpoints + serves frontend
│   ├── model_service.py        Loads and runs your real .pkl model
│   ├── feature_engineering.py  Sensor history buffer + rolling features
│   ├── digital_twin.py         Digital twin state, joints, alerts, explanations
│   ├── simulator.py            No-hardware sensor data generator
│   ├── config.py               ALL settings: paths, fault names, ranges
│   ├── schemas.py               Request/response data shapes
│   └── requirements.txt
│
├── model/
│   ├── predictive_maintenance_pipeline.pkl   <- your real trained model
│   ├── model_metadata.json
│   ├── feature_config.json
│   └── sample_input.json
│
├── frontend/
│   ├── index.html
│   ├── style.css
│   └── app.js
│
├── README.md
└── run.bat
```

---

## 5. Windows setup (VS Code)

1. Install Python 3.10+ from python.org if you don't already have it
   (tick "Add Python to PATH" during install).
2. Open a terminal in VS Code (`` Ctrl+` ``).
3. `cd` into the project folder:
   ```
   cd KSTARKOM_Digital_Twin
   ```
4. Create a virtual environment:
   ```
   python -m venv venv
   ```
5. Activate it:
   ```
   venv\Scripts\activate
   ```
   (you should see `(venv)` appear in your terminal prompt)
6. Install the required packages:
   ```
   pip install -r backend\requirements.txt
   ```
7. Start the backend:
   ```
   python backend\main.py
   ```
   Watch the terminal — it will print the model self-test result. If you
   see `[startup] Backend ready.`, everything worked.
8. Open your browser and go to:
   ```
   http://127.0.0.1:8000
   ```
   The dashboard should appear and start updating automatically within a
   couple of seconds.

### Or just double-click `run.bat`

`run.bat` automates steps 4–8 (creates the venv the first time, installs
requirements, and starts the server). After it starts, open
`http://127.0.0.1:8000` in your browser.

---

## 6. How each major piece works

- **`simulator.py`** — generates one new sensor reading every 1.5 seconds
  in a background thread. Three modes (`NORMAL`, `WARNING`, `FAULT`) are
  switchable live from the dashboard buttons or `POST /api/simulator/mode`.
- **`feature_engineering.py`** — keeps the last 200 readings in memory and,
  for every new reading, computes rolling mean/std (window=5) and rate of
  change for each of the 5 raw sensors, producing the same 20-feature shape
  your model was trained on.
- **`model_service.py`** — loads the pickle once at startup, reorders
  incoming features to exactly match `feature_cols` from the pickle, scales
  them with the same `StandardScaler`, and calls `predict()` /
  `predict_proba()`. Any feature mismatch raises a clear error instead of
  silently producing a wrong prediction.
- **`digital_twin.py`** — holds the current state of the whole conveyor:
  the model-driven health/risk/fault, plus simulated component and
  belt-joint health with simple rule-based alerts and a rule-based (not
  SHAP) explanation of contributing signals.
- **`main.py`** — wires it all together, runs a startup self-test
  (load model → feed sample readings → confirm a prediction comes back),
  and serves both the API and the frontend from one process.
- **`frontend/app.js`** — polls `/api/conveyor` every 1.5 seconds with
  `fetch()` (plain REST polling, no WebSocket, no page reloads) and updates
  the KPI cards, sensor cards, SVG digital twin, charts, joint table, and
  alert list.

---

## 7. REST API reference

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Backend + model load status |
| GET | `/api/model` | Model metadata (name, accuracy, sample counts) |
| GET | `/api/conveyor` | Full digital twin state (used by the dashboard) |
| GET | `/api/sensors` | Latest single sensor reading |
| GET | `/api/sensors/history?n=50` | Recent readings for charts |
| POST | `/api/predict` | Run one manual prediction on a supplied reading |
| GET | `/api/simulator` | Current simulator mode |
| POST | `/api/simulator/mode` | Change simulator mode: `NORMAL`/`WARNING`/`FAULT` |
| POST | `/api/vision/joint` | **Future extension point** — push a joint damage detection from a not-yet-built AI vision pipeline |

---

## 8. Connecting real hardware later

The architecture was built so you can swap the simulator out without
touching anything downstream:

```
ESP32 sensors --(MQTT)--> a small MQTT-to-HTTP bridge script
                              --> calls run_prediction_pipeline() in main.py
                              --> everything else (feature engineering,
                                  model, digital twin, dashboard) stays the same
```

Similarly, `POST /api/vision/joint` already exists so a future
camera + YOLO damage-detection pipeline can push a specific joint's
damage type/severity into the digital twin without any backend changes.

---

## 9. Limitations to be upfront about (for your report/demo)

- Test accuracy (~98.77%) is a **test-set** metric from your Colab
  training run, not a guarantee of real-world mine performance.
- Health/risk scores are **prototype estimations** using a transparent but
  simplified formula (see Section 2's caveat about the missing "normal"
  class) — they are not a certified condition-monitoring metric.
- Belt joint and component statuses are **simulated**, not measured.
- The "Why is the system predicting this?" panel uses simple threshold
  rules, **not SHAP** or any other real explainability technique.
- This has not been tested against a real mine deployment.

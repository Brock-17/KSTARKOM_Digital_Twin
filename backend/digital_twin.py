"""
digital_twin.py
-----------------
Holds the software "Digital Twin" state of the conveyor: overall
health/risk (driven by the real ML model), plus simulated component
and belt-joint statuses.

IMPORTANT HONESTY NOTE:
Only the overall health/risk/fault prediction comes from your real
trained model. The individual component statuses (motor, pulleys,
idlers, bearings) and the 5 belt joints (J1-J5) are SIMULATED for this
prototype -- there is no camera/vision system feeding them yet. The
code is structured so a future AI-vision pipeline can update a specific
joint via POST /api/vision/joint without changing anything else.
"""

import random
from datetime import datetime, timezone

import config


def _status_from_health(health: float) -> str:
    """Convert a 0-100 health score into a simple traffic-light status."""
    if health >= 80:
        return "Healthy"
    if health >= 50:
        return "Warning"
    return "Critical"


def _severity_label(health: float) -> str:
    if health >= 80:
        return "Low"
    if health >= 50:
        return "Medium"
    return "High"


class DigitalTwin:
    """
    In-memory representation of the conveyor's current state.
    Not a database -- resets when the backend restarts, which is fine
    for this prototype (real ESP32/MQTT sensors would just repopulate it).
    """

    def __init__(self):
        self.conveyor_id = "CONV-001"
        self.operating_status = "RUNNING"
        self.last_update = None

        # Overall figures, filled in every time a prediction runs
        self.speed = 0.0
        self.load = 0.0
        self.temperature = 0.0
        self.vibration = 0.0
        self.current = 0.0
        self.health_score = 100.0
        self.risk = 0.0
        self.predicted_fault = "Not yet predicted"
        self.fault_class = None
        self.confidence = 0.0
        self.risk_method = ""

        # Components -- start healthy, simulated drift applied on update
        self.components = {
            "Motor": 96.0,
            "Drive Pulley": 95.0,
            "Tail Pulley": 96.0,
            "Idlers": 94.0,
            "Bearings": 95.0,
            "Belt": 97.0,
        }

        # Belt joints -- each starts healthy; can later be overwritten by
        # a real AI-vision detection via update_joint_from_vision()
        self.joints = {
            j["joint_id"]: {
                "joint_id": j["joint_id"],
                "position": j["position"],
                "health": round(random.uniform(90, 99), 1),
                "damage": "Normal",
                "severity": "Low",
                "risk": 0.0,
                "source": "simulated",
            }
            for j in config.JOINTS
        }
        self._recompute_joint_risk()

    def _recompute_joint_risk(self):
        for joint in self.joints.values():
            joint["risk"] = round(max(0.0, min(1.0, (100 - joint["health"]) / 100)), 3)
            joint["severity"] = _severity_label(joint["health"])
            if joint["health"] >= 80:
                joint["damage"] = "Normal"
            elif joint["health"] >= 50 and joint["damage"] == "Normal":
                joint["damage"] = "Scratch"
            elif joint["damage"] == "Normal":
                joint["damage"] = "Tear"

    def update_from_prediction(self, sensor_values: dict, prediction: dict):
        """Called after every new prediction to refresh the twin's state."""
        self.speed = sensor_values["speed"]
        self.load = sensor_values["load"]
        self.temperature = sensor_values["temperature"]
        self.vibration = sensor_values["vibration"]
        self.current = sensor_values["current"]

        self.health_score = prediction["health_score"]
        self.risk = prediction["risk"]
        self.predicted_fault = prediction["predicted_fault"]
        self.fault_class = prediction["fault_class"]
        self.confidence = prediction["confidence"]
        self.risk_method = prediction["risk_method"]

        self.last_update = datetime.now(timezone.utc)

        self._simulate_component_drift()
        self._simulate_joint_drift()

    def _simulate_component_drift(self):
        """
        Simulated component health drift, loosely nudged by the real
        predicted fault so the dashboard feels connected to the model
        output. This is a simple, explainable rule set -- not a
        certified condition-monitoring system.
        """
        # Small random walk to keep numbers moving
        for name in self.components:
            drift = random.uniform(-0.4, 0.3)
            self.components[name] = max(0.0, min(100.0, self.components[name] + drift))

        # If the model currently predicts a fault tied to a specific
        # component family, nudge that component down a bit more,
        # proportional to the model's risk. This keeps the mapping
        # simple and rule-based (see explainability panel on frontend).
        fault_to_component = {
            "Ball Bearing Fault": "Bearings",
            "Belt Slippage": "Belt",
            "Central Shaft Fault": "Drive Pulley",
            "Drive Motor Fault": "Motor",
            "Idler Roller Fault": "Idlers",
            "Pulley Fault": "Tail Pulley",
        }
        component = fault_to_component.get(self.predicted_fault)
        if component:
            penalty = self.risk * random.uniform(2.0, 6.0)
            self.components[component] = max(0.0, self.components[component] - penalty)

    def _simulate_joint_drift(self):
        """Simulated belt-joint wear, occasionally introducing a warning."""
        for joint in self.joints.values():
            if joint.get("source") == "vision":
                continue  # a real vision update takes priority, don't overwrite it
            drift = random.uniform(-0.5, 0.3)
            joint["health"] = max(0.0, min(100.0, joint["health"] + drift))
        self._recompute_joint_risk()

    def update_joint_from_vision(self, joint_id: str, damage_type: str, severity: float):
        """
        FUTURE EXTENSION POINT: called by POST /api/vision/joint once a
        real camera + YOLO damage-detection pipeline exists. severity is
        expected to be 0.0 (no damage) - 1.0 (severe damage).
        """
        if joint_id not in self.joints:
            raise ValueError(f"Unknown joint_id '{joint_id}'. Known joints: {list(self.joints.keys())}")

        severity = max(0.0, min(1.0, severity))
        health = round(100 * (1 - severity), 1)
        self.joints[joint_id].update({
            "health": health,
            "damage": damage_type,
            "risk": round(severity, 3),
            "severity": _severity_label(health),
            "source": "vision",
        })

    def get_component_statuses(self) -> dict:
        return {
            name: {"health": round(health, 1), "status": _status_from_health(health)}
            for name, health in self.components.items()
        }

    def get_joints_summary(self) -> dict:
        joints = list(self.joints.values())
        healthy = sum(1 for j in joints if j["severity"] == "Low")
        warning = sum(1 for j in joints if j["severity"] == "Medium")
        critical = sum(1 for j in joints if j["severity"] == "High")
        return {"healthy": healthy, "warning": warning, "critical": critical, "total": len(joints)}

    def generate_alerts(self) -> list:
        """
        Simple, transparent rule-based alerts derived from current twin
        state. Not machine-learned -- just readable if/else logic so you
        can see exactly why an alert fired.
        """
        alerts = []

        if self.vibration > 3.0:
            alerts.append({"severity": "WARNING", "message": "High vibration detected"})
        if self.current > 12.0:
            alerts.append({"severity": "WARNING", "message": "Motor current increasing"})
        if self.temperature > 55.0:
            alerts.append({"severity": "WARNING", "message": "Temperature above normal range"})

        for joint in self.joints.values():
            if joint["severity"] == "High":
                alerts.append({
                    "severity": "CRITICAL",
                    "message": f"Joint {joint['joint_id']} requires inspection ({joint['damage']})",
                })
            elif joint["severity"] == "Medium":
                alerts.append({
                    "severity": "WARNING",
                    "message": f"Joint {joint['joint_id']} showing early wear ({joint['damage']})",
                })

        if self.risk >= 0.6:
            alerts.append({
                "severity": "CRITICAL",
                "message": f"High predictive-maintenance risk: {self.predicted_fault}",
            })
        elif self.risk >= 0.3:
            alerts.append({
                "severity": "WARNING",
                "message": f"Elevated risk indicator: {self.predicted_fault}",
            })

        if not alerts:
            alerts.append({"severity": "INFO", "message": "Conveyor operating normally"})

        return alerts

    def get_recommended_action(self) -> str:
        """Rule-based, explainable maintenance recommendation."""
        if self.risk >= 0.6:
            action_map = {
                "Ball Bearing Fault": "Inspect and lubricate/replace bearings",
                "Belt Slippage": "Check belt tension and drive traction",
                "Central Shaft Fault": "Inspect central shaft alignment and coupling",
                "Drive Motor Fault": "Inspect motor and drive assembly",
                "Idler Roller Fault": "Inspect idler rollers along the belt path",
                "Pulley Fault": "Inspect pulley surface and bearings",
            }
            return action_map.get(self.predicted_fault, "Schedule inspection of the flagged component")
        elif self.risk >= 0.3:
            return "Increase monitoring frequency and schedule a routine inspection"
        return "Continue monitoring"

    def get_explanation(self) -> dict:
        """
        Simple threshold-based 'explainability' (NOT SHAP -- SHAP is not
        implemented in this prototype, so we don't pretend it is).
        """
        signals = []
        if self.vibration > 2.5:
            signals.append("↑ Vibration")
        if self.current > 10.0:
            signals.append("↑ Motor Current")
        if self.temperature > 50.0:
            signals.append("↑ Temperature")
        if self.load > 700:
            signals.append("↑ Load")

        if not signals:
            signals.append("All monitored signals within normal range")

        return {
            "contributing_signals": signals,
            "possible_indication": self.predicted_fault if self.risk >= 0.3 else "No significant abnormality",
            "method": "threshold-based rule explanation (not SHAP)",
        }

    def to_state_dict(self) -> dict:
        return {
            "conveyor_id": self.conveyor_id,
            "operating_status": self.operating_status,
            "speed": self.speed,
            "load": self.load,
            "temperature": self.temperature,
            "vibration": self.vibration,
            "current": self.current,
            "health_score": self.health_score,
            "risk": self.risk,
            "predicted_fault": self.predicted_fault,
            "fault_class": self.fault_class,
            "confidence": self.confidence,
            "risk_method": self.risk_method,
            "last_update": self.last_update.isoformat() if self.last_update else None,
            "components": self.get_component_statuses(),
            "joints": list(self.joints.values()),
            "joints_summary": self.get_joints_summary(),
            "alerts": self.generate_alerts(),
            "recommended_action": self.get_recommended_action(),
            "explanation": self.get_explanation(),
        }


# Single shared instance used across the whole backend
digital_twin = DigitalTwin()

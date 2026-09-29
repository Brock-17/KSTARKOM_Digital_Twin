"""
schemas.py
----------
Pydantic models describing the shape of data going in and out of the API.
Keeping these separate makes main.py easier to read.
"""

from pydantic import BaseModel, Field
from typing import Optional, List


class SensorReading(BaseModel):
    """A single raw sensor reading sent to /api/predict."""
    speed: float = Field(..., description="Belt speed in rpm")
    load: float = Field(..., description="Load in kg")
    temperature: float = Field(..., description="Temperature in degrees C")
    vibration: float = Field(..., description="Vibration in m/s^2")
    current: float = Field(..., description="Motor current in Amps")


class PredictionResponse(BaseModel):
    predicted_fault: str
    fault_class: int
    confidence: float
    risk: float
    health_score: float
    risk_method: str  # explains HOW risk was computed (transparency)
    class_probabilities: dict


class SimulatorModeRequest(BaseModel):
    mode: str  # "NORMAL" | "WARNING" | "FAULT"


class VisionJointUpdate(BaseModel):
    """
    Placeholder schema for a FUTURE AI-vision integration.
    Not wired into any real computer-vision model yet -- this just shows
    how a future camera + YOLO pipeline could push updates into the
    Digital Twin for a specific joint.
    """
    joint_id: str
    damage_type: str
    severity: float  # 0.0 - 1.0

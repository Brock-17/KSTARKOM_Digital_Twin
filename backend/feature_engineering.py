"""
feature_engineering.py
-----------------------
Turns a stream of raw sensor readings into the 20-feature vector the
trained model expects.

The model was trained on:
  - 5 raw sensor values
  - 15 engineered features:
        <sensor>_rolling_mean        (window = 5)
        <sensor>_rolling_std         (window = 5)
        <sensor>_rate_of_change      (current - previous reading)

We keep an in-memory history buffer (see SensorHistory below) and
recompute these engineered features every time a new reading arrives,
using pandas .rolling() so the maths matches a typical training
pipeline built the same way (see model_metadata.json ->
preprocessing.feature_engineering).

Handling the first few readings:
  - rolling_mean / rolling_std with fewer than 5 samples: pandas'
    min_periods=1 lets us compute a mean/std from whatever we have so
    far, which avoids NaNs breaking the very first prediction. std of
    a single value is undefined, so we fill that one case with 0.0.
  - rate_of_change on the very first reading: there is no previous
    value, so we use 0.0 (no change yet).

This keeps every prediction numerically valid without silently
inventing sensor data.
"""

from collections import deque
from datetime import datetime, timezone
import pandas as pd

import config


class SensorHistory:
    """
    Simple in-memory buffer of recent sensor readings, plus the logic
    to turn that buffer into the exact feature vector the model needs.

    This is intentionally simple (a Python deque, not a database) so the
    prototype has zero external dependencies. When you move to real
    ESP32/MQTT sensors later, you can keep this class as-is and just
    call `.add_reading(...)` every time a real message arrives.
    """

    def __init__(self, max_length: int = config.MAX_HISTORY_LENGTH):
        self.readings = deque(maxlen=max_length)

    def add_reading(self, speed, load, temperature, vibration, current):
        """Store one new raw reading with a timestamp."""
        reading = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "Speed (rpm)": speed,
            "Load (kg)": load,
            "Temperature (℃)": temperature,
            "Vibration (m/s²)": vibration,
            "Current (A)": current,
        }
        self.readings.append(reading)
        return reading

    def has_data(self) -> bool:
        return len(self.readings) > 0

    def as_dataframe(self) -> pd.DataFrame:
        """All stored readings as a pandas DataFrame, oldest first."""
        return pd.DataFrame(list(self.readings))

    def recent_for_charts(self, n: int = 50):
        """Return the most recent n readings, for frontend charts."""
        return list(self.readings)[-n:]

    def build_feature_vector(self) -> pd.DataFrame:
        """
        Build the exact 20-column feature vector for the CURRENT
        (most recent) reading, using the rolling window defined in
        config.ROLLING_WINDOW.

        Returns a single-row pandas DataFrame with columns matching
        config.RAW_FEATURE_COLUMNS + the 15 engineered feature names,
        ready to hand to model_service.predict().
        """
        if not self.has_data():
            raise ValueError("No sensor readings available yet -- add a reading first.")

        df = self.as_dataframe()
        window = config.ROLLING_WINDOW

        feature_row = {}
        for col in config.RAW_FEATURE_COLUMNS:
            series = df[col]

            current_value = series.iloc[-1]
            feature_row[col] = current_value

            # Rolling mean / std over the last `window` readings.
            # min_periods=1 so this still works before we have 5 readings.
            rolling_window = series.tail(window)
            feature_row[f"{col}_rolling_mean"] = rolling_window.mean()

            if len(rolling_window) > 1:
                feature_row[f"{col}_rolling_std"] = rolling_window.std()
            else:
                # std of a single value is undefined -- use 0.0 instead of NaN
                feature_row[f"{col}_rolling_std"] = 0.0

            # Rate of change vs the previous reading (0.0 if this is the
            # very first reading -- nothing to compare against yet).
            if len(series) > 1:
                feature_row[f"{col}_rate_of_change"] = current_value - series.iloc[-2]
            else:
                feature_row[f"{col}_rate_of_change"] = 0.0

        return pd.DataFrame([feature_row])

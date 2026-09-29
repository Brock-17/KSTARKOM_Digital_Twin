"""
simulator.py
-------------
Generates realistic-looking conveyor sensor data WITHOUT any hardware,
MQTT, or cloud services. This lets you build and demo the whole system
today, and swap this module out for a real ESP32 + MQTT feed later
(everything downstream -- feature engineering, model, digital twin --
stays the same).

Modes:
    NORMAL  - values stay inside the normal operating ranges
    WARNING - one or two signals drift toward the edge of normal
    FAULT   - a clear abnormal pattern is injected (high vibration,
              motor overheating, heavy load, or pulley/idler issue)
"""

import random
import threading
import time

import config


class SensorSimulator:
    def __init__(self):
        self.mode = "NORMAL"
        self.fault_type = None  # which kind of fault pattern is active
        self._lock = threading.Lock()
        self._running = False
        self._thread = None

        # Track last values so changes look smooth/continuous rather than
        # jumping randomly every tick.
        low_speed, high_speed = config.NORMAL_RANGES["speed"]
        low_load, high_load = config.NORMAL_RANGES["load"]
        low_temp, high_temp = config.NORMAL_RANGES["temperature"]
        low_vib, high_vib = config.NORMAL_RANGES["vibration"]
        low_cur, high_cur = config.NORMAL_RANGES["current"]

        self._last = {
            "speed": (low_speed + high_speed) / 2,
            "load": (low_load + high_load) / 2,
            "temperature": (low_temp + high_temp) / 2,
            "vibration": (low_vib + high_vib) / 2,
            "current": (low_cur + high_cur) / 2,
        }

    def set_mode(self, mode: str):
        mode = mode.upper()
        if mode not in ("NORMAL", "WARNING", "FAULT"):
            raise ValueError("mode must be one of: NORMAL, WARNING, FAULT")
        with self._lock:
            self.mode = mode
            if mode == "FAULT":
                self.fault_type = random.choice(
                    ["high_vibration", "motor_problem", "heavy_load", "pulley_idler"]
                )
            else:
                self.fault_type = None

    def get_status(self) -> dict:
        with self._lock:
            return {"mode": self.mode, "fault_type": self.fault_type}

    def _clamp_walk(self, key, low, high, step):
        """Move the last value a small random step, staying near [low, high]."""
        value = self._last[key] + random.uniform(-step, step)
        value = max(low - (high - low) * 0.1, min(high + (high - low) * 0.1, value))
        self._last[key] = value
        return value

    def generate_reading(self) -> dict:
        """Produce one new sensor reading based on the current mode."""
        with self._lock:
            mode = self.mode
            fault_type = self.fault_type

        speed_lo, speed_hi = config.NORMAL_RANGES["speed"]
        load_lo, load_hi = config.NORMAL_RANGES["load"]
        temp_lo, temp_hi = config.NORMAL_RANGES["temperature"]
        vib_lo, vib_hi = config.NORMAL_RANGES["vibration"]
        cur_lo, cur_hi = config.NORMAL_RANGES["current"]

        speed = self._clamp_walk("speed", speed_lo, speed_hi, 1.2)
        load = self._clamp_walk("load", load_lo, load_hi, 6.0)
        temperature = self._clamp_walk("temperature", temp_lo, temp_hi, 0.6)
        vibration = self._clamp_walk("vibration", vib_lo, vib_hi, 0.04)
        current = self._clamp_walk("current", cur_lo, cur_hi, 0.05)

        if mode == "WARNING":
            # Nudge one or two signals a bit past the edge of normal --
            # noticeable on the dashboard, but not as extreme as a full FAULT.
            vibration = vib_hi + random.uniform(0.05, 0.2)
            current = cur_hi + random.uniform(0.1, 0.4)

        elif mode == "FAULT":
            # These offsets are calibrated to the model's real training
            # distribution (see NORMAL_RANGES note in config.py) so the
            # injected fault patterns land in a region the model was
            # actually trained to recognize, instead of far outside it.
            if fault_type == "high_vibration":
                vibration = vib_hi + random.uniform(0.4, 0.9)
            elif fault_type == "motor_problem":
                current = cur_hi + random.uniform(1.2, 2.5)
                temperature = temp_hi + random.uniform(8.0, 16.0)
            elif fault_type == "heavy_load":
                load = load_hi + random.uniform(80, 160)
                current = cur_hi + random.uniform(0.6, 1.2)
            elif fault_type == "pulley_idler":
                vibration = vib_hi + random.uniform(0.3, 0.7)

        return {
            "speed": round(speed, 2),
            "load": round(load, 2),
            "temperature": round(temperature, 2),
            "vibration": round(vibration, 3),
            "current": round(current, 2),
        }

    def start_background_loop(self, on_new_reading):
        """
        Starts a background thread that calls `on_new_reading(reading_dict)`
        every SIMULATOR_INTERVAL_SECONDS. `on_new_reading` is provided by
        main.py and is responsible for running feature engineering,
        prediction, and updating the digital twin.
        """
        if self._running:
            return

        self._running = True

        def loop():
            while self._running:
                try:
                    reading = self.generate_reading()
                    on_new_reading(reading)
                except Exception as e:
                    # Never let the background loop die silently
                    print(f"[simulator] Error in background loop: {e}")
                time.sleep(config.SIMULATOR_INTERVAL_SECONDS)

        self._thread = threading.Thread(target=loop, daemon=True)
        self._thread.start()

    def stop(self):
        self._running = False


# Single shared instance used across the whole backend
simulator = SensorSimulator()

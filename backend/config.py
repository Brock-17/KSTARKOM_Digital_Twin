"""
config.py
---------
All project-wide settings live here so you can tweak the system
without hunting through every file.

VERIFIED FAULT CLASS MAPPING
-----------------------------
We inspected the actual trained pipeline (predictive_maintenance_pipeline.pkl)
before writing any code. Inside the pickle there is a dict with these keys:

    model            -> XGBClassifier (predict / predict_proba both work)
    scaler           -> StandardScaler fit on 20 features
    feature_cols     -> the exact 20 feature names, in the exact order
                        the model expects
    label_encoders   -> {'Fault': LabelEncoder(...)}
    target_col       -> 'Fault'
    model_type       -> 'XGBoost'

The LabelEncoder for the target column ('Fault') was fit with
scikit-learn's default behaviour, which sorts the class labels
ALPHABETICALLY and assigns them integers 0..N-1 in that sorted order.

We printed `label_encoders['Fault'].classes_` directly from the loaded
pickle and got, in order (index = numeric class the model predicts):

    0 -> 'ball bearing'
    1 -> 'belt slippage'
    2 -> 'central shaft'
    3 -> 'drive motor'
    4 -> 'idler roller fault'
    5 -> 'pulley'

IMPORTANT / HONEST CAVEAT:
There is NO "Normal" class anywhere in this encoder. All six classes
described by the model are fault/condition categories -- the training
data apparently did not include a distinct "normal operation" label
(or "belt slippage" may represent the mildest/least-severe condition
in the dataset, but we cannot confirm that from the files provided).

Because we can NOT verify which class (if any) represents normal,
undamaged operation, we do NOT compute:

    risk = 1 - probability_of_normal_class

Instead, per a transparent/prototype approach, we compute:

    risk = 1 - confidence   (confidence = highest predicted probability)

This is clearly labelled everywhere in the API and the UI as a
PROTOTYPE risk indicator, not a validated industrial metric.

If you later confirm (e.g. from your original training notebook/dataset)
that one of these six classes actually represents "normal" operation,
just tell me which one and I will switch the risk formula back to the
probability-of-normal approach in one place (see model_service.py).
"""

import os

# ---------------------------------------------------------------------------
# Paths (all relative, so the project can be moved/copied anywhere)
# ---------------------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_DIR = os.path.join(BASE_DIR, "model")
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")

PIPELINE_PATH = os.path.join(MODEL_DIR, "predictive_maintenance_pipeline.pkl")
METADATA_PATH = os.path.join(MODEL_DIR, "model_metadata.json")
FEATURE_CONFIG_PATH = os.path.join(MODEL_DIR, "feature_config.json")
SAMPLE_INPUT_PATH = os.path.join(MODEL_DIR, "sample_input.json")

# ---------------------------------------------------------------------------
# Fault class names -- EDIT THIS DICT if you confirm better names later.
# Keys MUST match the numeric classes the model outputs (0-5).
# This mapping was derived directly from label_encoders['Fault'].classes_
# inside your trained pickle (see docstring above). It is a real, verified
# mapping, not a guess -- but the identification of which class (if any)
# is "healthy" is NOT verified, so treat class meanings as fault
# *categories*, not certainties about mine-specific behaviour.
# ---------------------------------------------------------------------------
FAULT_CLASS_NAMES = {
    0: "Ball Bearing Fault",
    1: "Belt Slippage",
    2: "Central Shaft Fault",
    3: "Drive Motor Fault",
    4: "Idler Roller Fault",
    5: "Pulley Fault",
}

# None of the six trained classes could be verified as "normal operation".
# Keep this as None unless you confirm otherwise (see docstring above).
NORMAL_CLASS_INDEX = None

# ---------------------------------------------------------------------------
# Sensor history / feature engineering
# ---------------------------------------------------------------------------
# The model was trained using a rolling window of 5 (see
# model_metadata.json -> preprocessing.feature_engineering).
ROLLING_WINDOW = 5

# Original 5 raw sensor columns, using the EXACT column names the model
# was trained on (must match feature_config.json "original_columns").
RAW_FEATURE_COLUMNS = [
    "Speed (rpm)",
    "Load (kg)",
    "Temperature (℃)",
    "Vibration (m/s²)",
    "Current (A)",
]

# Friendly key (used by the API / simulator) -> exact training column name
SENSOR_KEY_TO_COLUMN = {
    "speed": "Speed (rpm)",
    "load": "Load (kg)",
    "temperature": "Temperature (℃)",
    "vibration": "Vibration (m/s²)",
    "current": "Current (A)",
}

# How many recent readings to keep in memory (only need ROLLING_WINDOW for
# feature engineering, but we keep a bit more so charts have history too).
MAX_HISTORY_LENGTH = 200

# ---------------------------------------------------------------------------
# Digital twin belt joints (simulated positions along the conveyor, in metres)
# ---------------------------------------------------------------------------
JOINTS = [
    {"joint_id": "J1", "position": 10},
    {"joint_id": "J2", "position": 25},
    {"joint_id": "J3", "position": 40},
    {"joint_id": "J4", "position": 55},
    {"joint_id": "J5", "position": 70},
]

# ---------------------------------------------------------------------------
# Simulator settings -- realistic "normal" operating ranges
#
# IMPORTANT CALIBRATION NOTE:
# We inspected the actual StandardScaler stored inside your trained pickle
# (scaler.mean_ / scaler.scale_) to see what sensor ranges the model was
# ACTUALLY trained on. They turned out to be much narrower for vibration
# and current than typical "textbook" mining-conveyor numbers:
#
#     feature              training mean   training std
#     Speed (rpm)                120.8           4.6
#     Load (kg)                  506.7          18.4
#     Temperature (deg C)         41.6           3.2
#     Vibration (m/s^2)            0.86          0.13
#     Current (A)                  3.43          0.23
#
# If we simulated "normal" data using generic ranges like 5-12A current or
# 1-3 m/s^2 vibration, every simulated reading would actually be WAY
# outside what the model ever saw during training -- the model would then
# be extrapolating wildly and would likely predict the same fault with
# artificially high confidence almost all the time, regardless of
# simulator mode. That would make the demo look broken/meaningless even
# though the model itself is fine.
#
# So NORMAL_RANGES below are calibrated to roughly mean +/- 2 std of the
# REAL training data (verified from the scaler), not the illustrative
# ranges in the original project brief. WARNING/FAULT modes then push
# specific sensors further away from this real distribution, which we
# confirmed (via a manual test) produces clearly different, high-confidence
# predictions across different simulated fault types.
#
# If you have your own domain knowledge of what "normal" should look like
# on a real mine conveyor and it differs from this, you can edit these
# ranges -- just keep in mind values far outside the training distribution
# will make the model's predictions less meaningful, not more.
# ---------------------------------------------------------------------------
NORMAL_RANGES = {
    "speed": (112, 130),          # rpm
    "load": (470, 543),           # kg
    "temperature": (35, 48),      # degC
    "vibration": (0.6, 1.12),     # m/s^2
    "current": (2.97, 3.9),       # A
}

SIMULATOR_INTERVAL_SECONDS = 1.5

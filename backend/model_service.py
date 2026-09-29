"""
model_service.py
------------------
Loads and runs YOUR actual trained pipeline
(predictive_maintenance_pipeline.pkl). Nothing in this file trains,
retrains, or fakes a model -- it only loads what you already trained
in Colab and calls .predict() / .predict_proba() on it.

WHAT'S INSIDE THE PICKLE (verified by loading it directly):
    {
        "model": XGBClassifier,          # trained, 6-class classifier
        "scaler": StandardScaler,        # fit on the 20 training features
        "feature_cols": [...20 names...],# EXACT column order the model needs
        "label_encoders": {"Fault": LabelEncoder},
        "target_col": "Fault",
        "model_type": "XGBoost",
    }

Prediction pipeline (matches how the model was trained):
    raw features + engineered features (20 total, in feature_cols order)
        -> scaler.transform()
        -> model.predict() / model.predict_proba()
        -> LabelEncoder.inverse_transform() to get the human-readable
           label the model was trained on ('ball bearing', 'drive motor', ...)
        -> config.FAULT_CLASS_NAMES to get the nicer display name for the UI
"""

import json
import joblib
import pandas as pd

import config


class ModelService:
    def __init__(self):
        self.model = None
        self.scaler = None
        self.feature_cols = None
        self.label_encoder = None
        self.model_type = None
        self.metadata = None
        self.feature_config = None
        self.loaded = False
        self.load_error = None

    def load(self):
        """
        Load the pickle + metadata JSON files from disk.
        Any failure here is raised loudly (not swallowed) so problems
        are obvious immediately instead of causing confusing bugs later.
        """
        try:
            pipeline_dict = joblib.load(config.PIPELINE_PATH)
        except Exception as e:
            self.load_error = f"Failed to load pipeline pickle: {e}"
            raise

        # The pickle is a plain dict (verified by inspecting it directly),
        # not a scikit-learn Pipeline object -- so we pull pieces out by key.
        required_keys = ["model", "scaler", "feature_cols", "label_encoders", "target_col"]
        for key in required_keys:
            if key not in pipeline_dict:
                raise KeyError(
                    f"Expected key '{key}' not found in predictive_maintenance_pipeline.pkl. "
                    f"Found keys: {list(pipeline_dict.keys())}"
                )

        self.model = pipeline_dict["model"]
        self.scaler = pipeline_dict["scaler"]
        self.feature_cols = pipeline_dict["feature_cols"]
        self.label_encoder = pipeline_dict["label_encoders"][pipeline_dict["target_col"]]
        self.model_type = pipeline_dict.get("model_type", "unknown")

        with open(config.METADATA_PATH, "r", encoding="utf-8") as f:
            self.metadata = json.load(f)

        with open(config.FEATURE_CONFIG_PATH, "r", encoding="utf-8") as f:
            self.feature_config = json.load(f)

        # Sanity check: the feature order inside the pickle should match
        # feature_config.json. If it doesn't, we FIX it rather than hide it --
        # here that means trusting the pickle's own feature_cols (it's what
        # the scaler/model were actually fit on) but warning loudly.
        expected = self.feature_config.get("features", [])
        if list(self.feature_cols) != list(expected):
            print(
                "[WARNING] feature_config.json feature order does not exactly "
                "match the order stored inside the pickle. Using the pickle's "
                "own feature_cols (the order the scaler/model were fit on) "
                "since that is the ground truth for correct predictions."
            )
            print("  pickle feature_cols :", self.feature_cols)
            print("  feature_config.json :", expected)

        self.loaded = True
        print(f"[model_service] Loaded {self.model_type} model with "
              f"{len(self.feature_cols)} features. "
              f"Classes (numeric -> trained label): "
              f"{dict(enumerate(self.label_encoder.classes_))}")

    def get_model_info(self) -> dict:
        perf = (self.metadata or {}).get("performance_metrics", {})
        dataset = (self.metadata or {}).get("dataset_info", {})
        features = (self.metadata or {}).get("features", {})
        return {
            "model_name": (self.metadata or {}).get("model_name", "Unknown"),
            "model_type": self.model_type,
            "training_samples": dataset.get("training_samples"),
            "test_samples": dataset.get("test_samples"),
            "total_samples": dataset.get("total_samples_used"),
            "original_features": features.get("original_features"),
            "engineered_features": features.get("engineered_features"),
            "total_features": features.get("total_features"),
            "accuracy": perf.get("accuracy"),
            "f1_score": perf.get("f1_score"),
            "note": (
                "Accuracy/F1 shown here are the test-set metrics reported "
                "during model development in Colab. They describe performance "
                "on held-out historical data, not a guarantee of real-world "
                "mine performance."
            ),
        }

    def predict(self, feature_row: pd.DataFrame) -> dict:
        """
        Run one prediction.

        feature_row: a single-row DataFrame containing all 20 features
                     (any column order -- we reorder to match feature_cols
                     before scaling, since XGBoost/StandardScaler care
                     about column order, not names).

        Returns a dict with the predicted class, human-readable name,
        confidence, and full class-probability breakdown.
        """
        if not self.loaded:
            raise RuntimeError("Model is not loaded yet. Call load() first.")

        missing = [c for c in self.feature_cols if c not in feature_row.columns]
        if missing:
            raise ValueError(
                f"Feature mismatch: the following required features are missing "
                f"from the input before prediction: {missing}. "
                f"Expected exactly: {self.feature_cols}"
            )

        # Reorder columns to EXACTLY match what the scaler/model were fit on.
        ordered = feature_row[self.feature_cols]

        scaled = self.scaler.transform(ordered)

        predicted_class = int(self.model.predict(scaled)[0])

        class_probabilities = {}
        confidence = None
        if hasattr(self.model, "predict_proba"):
            proba = self.model.predict_proba(scaled)[0]
            for class_idx, prob in zip(self.model.classes_, proba):
                class_idx = int(class_idx)
                label = config.FAULT_CLASS_NAMES.get(class_idx, f"Class {class_idx}")
                class_probabilities[label] = round(float(prob), 4)
            confidence = float(max(proba))
        else:
            # Fallback: no probability output available from this model.
            confidence = 1.0

        predicted_label = config.FAULT_CLASS_NAMES.get(
            predicted_class, f"Class {predicted_class}"
        )

        # --- Risk calculation (see config.py docstring for full reasoning) ---
        # We could NOT verify which class (if any) represents normal,
        # undamaged operation inside this model, so we use the transparent
        # fallback formula and label it clearly as a prototype indicator.
        if config.NORMAL_CLASS_INDEX is not None and class_probabilities:
            normal_label = config.FAULT_CLASS_NAMES.get(config.NORMAL_CLASS_INDEX)
            prob_normal = class_probabilities.get(normal_label, 1 - confidence)
            risk = 1 - prob_normal
            risk_method = "1 - probability_of_normal_class (verified normal class)"
        else:
            risk = 1 - confidence
            risk_method = (
                "1 - model_confidence (PROTOTYPE fallback: no class in this "
                "model could be verified as representing normal operation)"
            )

        risk = max(0.0, min(1.0, risk))
        health_score = max(0.0, min(100.0, 100.0 * (1 - risk)))

        return {
            "fault_class": predicted_class,
            "predicted_fault": predicted_label,
            "confidence": round(confidence, 4),
            "risk": round(risk, 4),
            "health_score": round(health_score, 2),
            "risk_method": risk_method,
            "class_probabilities": class_probabilities,
        }


# Single shared instance used across the whole backend
model_service = ModelService()

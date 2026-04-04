"""
Process-wide Python startup customizations for local model-serving helpers.

This lets us opt into trusted legacy Keras model deserialization without
patching the upstream training repo.
"""

try:
	import keras
	keras.config.enable_unsafe_deserialization()
except Exception:
	pass

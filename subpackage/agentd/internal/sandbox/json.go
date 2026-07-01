//go:build linux
// +build linux

package sandbox

import "encoding/json"

// jsonMarshalQuiet marshals v to JSON, returning the bytes or an error.
// Wrapped to keep call sites short and to centralize any future format tweaks.
func jsonMarshalQuiet(v any) ([]byte, error) {
	return json.Marshal(v)
}

// jsonUnmarshalQuiet parses raw into v. Wrapped for symmetry with
// jsonMarshalQuiet and to keep call sites short.
func jsonUnmarshalQuiet(raw []byte, v any) error {
	return json.Unmarshal(raw, v)
}

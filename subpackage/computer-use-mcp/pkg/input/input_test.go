package input

import (
	"testing"
)

func TestNewController(t *testing.T) {
	controller, err := New(2.0)
	if err != nil {
		t.Fatalf("Failed to create controller: %v", err)
	}

	if controller == nil {
		t.Fatal("Controller should not be nil")
	}

	if controller.CoordMapper() == nil {
		t.Error("CoordMapper should not be nil")
	}
}

func TestNewWithOrigin(t *testing.T) {
	controller, err := NewWithOrigin(1.5, 100, 200)
	if err != nil {
		t.Fatalf("Failed to create controller with origin: %v", err)
	}

	if controller == nil {
		t.Fatal("Controller should not be nil")
	}

	mapper := controller.CoordMapper()
	if mapper == nil {
		t.Fatal("CoordMapper should not be nil")
	}

	// Test coordinate mapping
	nativeX, nativeY := mapper.ToNative(100, 100)
	if nativeX == 0 && nativeY == 0 {
		t.Error("Coordinate mapping should not return zero")
	}
}

func TestMouseMove(t *testing.T) {
	controller, err := New(1.0)
	if err != nil {
		t.Skipf("Skipping test (no display?): %v", err)
	}

	// Just test that it doesn't panic
	// Actual mouse movement is hard to verify in tests
	err = controller.MouseMove(100, 100)
	if err != nil {
		t.Logf("MouseMove failed (expected in headless): %v", err)
	}
}

func TestMouseClick(t *testing.T) {
	controller, err := New(1.0)
	if err != nil {
		t.Skipf("Skipping test (no display?): %v", err)
	}

	// Test all button types
	buttons := []string{"left", "right", "middle"}
	for _, button := range buttons {
		err = controller.MouseClick(100, 100, button, false)
		if err != nil {
			t.Logf("MouseClick %s failed (expected in headless): %v", button, err)
		}
	}

	// Test double click
	err = controller.MouseClick(100, 100, "left", true)
	if err != nil {
		t.Logf("Double click failed (expected in headless): %v", err)
	}
}

func TestMouseDrag(t *testing.T) {
	controller, err := New(1.0)
	if err != nil {
		t.Skipf("Skipping test (no display?): %v", err)
	}

	err = controller.MouseDrag(100, 100, 200, 200)
	if err != nil {
		t.Logf("MouseDrag failed (expected in headless): %v", err)
	}
}

func TestTypeText(t *testing.T) {
	controller, err := New(1.0)
	if err != nil {
		t.Skipf("Skipping test (no display?): %v", err)
	}

	err = controller.TypeText("Hello, World!")
	if err != nil {
		t.Logf("TypeText failed (expected in headless): %v", err)
	}
}

func TestKeyEvent(t *testing.T) {
	controller, err := New(1.0)
	if err != nil {
		t.Skipf("Skipping test (no display?): %v", err)
	}

	keys := []string{"Enter", "Escape", "Tab", "Backspace"}
	directions := []string{"down", "up", "click"}

	for _, key := range keys {
		for _, direction := range directions {
			err = controller.KeyEvent(key, direction)
			if err != nil {
				t.Logf("KeyEvent %s %s failed (expected in headless): %v", key, direction, err)
			}
		}
	}
}

func TestKeyCombo(t *testing.T) {
	controller, err := New(1.0)
	if err != nil {
		t.Skipf("Skipping test (no display?): %v", err)
	}

	// Test common key combinations
	combos := []struct {
		key       string
		modifiers []string
	}{
		{"c", []string{"Control"}},
		{"v", []string{"Control"}},
		{"s", []string{"Control"}},
		{"a", []string{"Control", "Shift"}},
	}

	for _, combo := range combos {
		err = controller.KeyCombo(combo.key, combo.modifiers)
		if err != nil {
			t.Logf("KeyCombo %v+%s failed (expected in headless): %v", combo.modifiers, combo.key, err)
		}
	}
}

func TestInvalidButton(t *testing.T) {
	controller, err := New(1.0)
	if err != nil {
		t.Skipf("Skipping test (no display?): %v", err)
	}

	// Test invalid button (should still work or return meaningful error)
	err = controller.MouseClick(100, 100, "invalid", false)
	if err != nil {
		t.Logf("Invalid button handled: %v", err)
	}
}

func TestKeyMapping(t *testing.T) {
	// Test that key mappings exist for common keys
	commonKeys := []string{
		"Enter", "Return", "Escape", "Tab", "Backspace",
		"Delete", "Home", "End", "PageUp", "PageDown",
		"Up", "Down", "Left", "Right",
		"Shift", "Control", "Alt", "Command",
	}

	// This is a smoke test to ensure key names are recognized
	controller, err := New(1.0)
	if err != nil {
		t.Skipf("Skipping test (no display?): %v", err)
	}

	for _, key := range commonKeys {
		// Just verify it doesn't panic with these key names
		_ = controller.KeyEvent(key, "click")
	}
}

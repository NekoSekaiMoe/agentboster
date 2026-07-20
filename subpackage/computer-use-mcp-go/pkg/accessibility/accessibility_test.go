package accessibility

import (
	"encoding/json"
	"testing"
)

func TestNewClient(t *testing.T) {
	client, err := New()
	if err != nil {
		t.Logf("Failed to create client (expected in CI/headless): %v", err)
		t.Skip("Accessibility not available")
	}
	defer client.Close()

	if client == nil {
		t.Fatal("Client should not be nil")
	}
}

func TestGetTree(t *testing.T) {
	client, err := New()
	if err != nil {
		t.Logf("Skipping test (no accessibility): %v", err)
		t.Skip()
	}
	defer client.Close()

	tree, err := client.GetTree()
	if err != nil {
		t.Fatalf("GetTree failed: %v", err)
	}

	if tree == nil {
		t.Fatal("Tree should not be nil")
	}

	// Should have basic properties
	if tree.ID == "" {
		t.Error("Root node should have an ID")
	}

	// Marshal to JSON to verify structure
	data, err := json.MarshalIndent(tree, "", "  ")
	if err != nil {
		t.Errorf("Failed to marshal tree: %v", err)
	}

	t.Logf("Tree structure:\n%s", string(data))
}

func TestGetNodeByID(t *testing.T) {
	client, err := New()
	if err != nil {
		t.Logf("Skipping test (no accessibility): %v", err)
		t.Skip()
	}
	defer client.Close()

	// Try to get element at screen center
	node, err := client.GetNodeByID("500,400")
	if err != nil {
		t.Logf("GetNodeByID failed (expected if no element at position): %v", err)
		return
	}

	if node == nil {
		t.Fatal("Node should not be nil")
	}

	if node.ID == "" {
		t.Error("Node should have an ID")
	}

	t.Logf("Found node: role=%s name=%s bounds=%+v", node.Role, node.Name, node.Bounds)
}

func TestInvalidNodeID(t *testing.T) {
	client, err := New()
	if err != nil {
		t.Logf("Skipping test (no accessibility): %v", err)
		t.Skip()
	}
	defer client.Close()

	// Invalid format should fail
	_, err = client.GetNodeByID("invalid")
	if err == nil {
		t.Error("Expected error for invalid node ID format")
	}
}

func TestPerformAction(t *testing.T) {
	client, err := New()
	if err != nil {
		t.Logf("Skipping test (no accessibility): %v", err)
		t.Skip()
	}
	defer client.Close()

	// Try to perform action on a node
	// This is a no-op test to verify the method doesn't crash
	err = client.PerformAction("500,400", "click")
	if err != nil {
		t.Logf("PerformAction failed (expected if no element): %v", err)
	}
}

func TestNodeStructure(t *testing.T) {
	node := Node{
		ID:          "test-id",
		Role:        "button",
		Name:        "Click Me",
		Description: "A test button",
		Value:       "pressed",
		Bounds: Bounds{
			X:      100,
			Y:      200,
			Width:  80,
			Height: 30,
		},
		Attributes: map[string]string{
			"state": "enabled",
		},
	}

	// Marshal to JSON
	data, err := json.Marshal(node)
	if err != nil {
		t.Fatalf("Failed to marshal node: %v", err)
	}

	// Unmarshal back
	var decoded Node
	err = json.Unmarshal(data, &decoded)
	if err != nil {
		t.Fatalf("Failed to unmarshal node: %v", err)
	}

	// Verify fields
	if decoded.ID != node.ID {
		t.Errorf("ID mismatch: got %s, want %s", decoded.ID, node.ID)
	}
	if decoded.Role != node.Role {
		t.Errorf("Role mismatch: got %s, want %s", decoded.Role, node.Role)
	}
	if decoded.Name != node.Name {
		t.Errorf("Name mismatch: got %s, want %s", decoded.Name, node.Name)
	}
	if decoded.Bounds.X != node.Bounds.X {
		t.Errorf("Bounds.X mismatch: got %d, want %d", decoded.Bounds.X, node.Bounds.X)
	}
}

func TestBoundsCenter(t *testing.T) {
	bounds := Bounds{
		X:      100,
		Y:      200,
		Width:  80,
		Height: 40,
	}

	centerX := bounds.X + bounds.Width/2   // 140
	centerY := bounds.Y + bounds.Height/2  // 220

	if centerX != 140 {
		t.Errorf("Center X: got %d, want 140", centerX)
	}
	if centerY != 220 {
		t.Errorf("Center Y: got %d, want 220", centerY)
	}
}

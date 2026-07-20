//go:build linux

package accessibility

import (
	"fmt"
	"unsafe"

	"github.com/ebitengine/purego"
)

type linuxBackend struct {
	libatspi   uintptr
	libglib    uintptr
	libgobject uintptr

	// AT-SPI functions
	atspiInit                        func() int32
	atspiGetDesktopCount             func() int32
	atspiGetDesktop                  func(index int32) uintptr
	atspiAccessibleGetChildCount     func(obj uintptr, error *uintptr) int32
	atspiAccessibleGetChildAtIndex   func(obj uintptr, index int32, error *uintptr) uintptr
	atspiAccessibleGetRole           func(obj uintptr, error *uintptr) int32
	atspiAccessibleGetName           func(obj uintptr, error *uintptr) uintptr
	atspiAccessibleGetDescription    func(obj uintptr, error *uintptr) uintptr
	atspiAccessibleGetStateSet       func(obj uintptr, error *uintptr) uintptr
	atspiAccessibleGetComponentIface func(obj uintptr) uintptr
	atspiComponentGetExtents         func(component uintptr, coordType int32, error *uintptr) uintptr
	atspiComponentGetAccessibleAtPoint func(component uintptr, x int32, y int32, coordType int32, error *uintptr) uintptr
	atspiActionDoAction              func(obj uintptr, index int32, error *uintptr) bool
	atspiRoleGetName                 func(role int32) uintptr

	// GLib functions
	gErrorFree   func(error uintptr)
	gObjectUnref func(obj uintptr)
	gFree        func(mem uintptr)
}

const (
	atspiCoordTypeScreen int32 = 0
	atspiRoleUnknown     int32 = 0
)

func newLinuxBackend() (*linuxBackend, error) {
	b := &linuxBackend{}

	var err error
	b.libatspi, err = purego.Dlopen("libatspi.so.0", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		return nil, fmt.Errorf("failed to load libatspi: %w", err)
	}

	// Load libgobject first (g_object_unref is in libgobject, not libglib)
	b.libgobject, err = purego.Dlopen("libgobject-2.0.so.0", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		return nil, fmt.Errorf("failed to load libgobject: %w", err)
	}

	b.libglib, err = purego.Dlopen("libglib-2.0.so.0", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		return nil, fmt.Errorf("failed to load libglib: %w", err)
	}

	// Register AT-SPI functions
	purego.RegisterLibFunc(&b.atspiInit, b.libatspi, "atspi_init")
	purego.RegisterLibFunc(&b.atspiGetDesktopCount, b.libatspi, "atspi_get_desktop_count")
	purego.RegisterLibFunc(&b.atspiGetDesktop, b.libatspi, "atspi_get_desktop")
	purego.RegisterLibFunc(&b.atspiAccessibleGetChildCount, b.libatspi, "atspi_accessible_get_child_count")
	purego.RegisterLibFunc(&b.atspiAccessibleGetChildAtIndex, b.libatspi, "atspi_accessible_get_child_at_index")
	purego.RegisterLibFunc(&b.atspiAccessibleGetRole, b.libatspi, "atspi_accessible_get_role")
	purego.RegisterLibFunc(&b.atspiAccessibleGetName, b.libatspi, "atspi_accessible_get_name")
	purego.RegisterLibFunc(&b.atspiAccessibleGetDescription, b.libatspi, "atspi_accessible_get_description")
	purego.RegisterLibFunc(&b.atspiAccessibleGetStateSet, b.libatspi, "atspi_accessible_get_state_set")
	purego.RegisterLibFunc(&b.atspiAccessibleGetComponentIface, b.libatspi, "atspi_accessible_get_component_iface")
	purego.RegisterLibFunc(&b.atspiComponentGetExtents, b.libatspi, "atspi_component_get_extents")
	purego.RegisterLibFunc(&b.atspiComponentGetAccessibleAtPoint, b.libatspi, "atspi_component_get_accessible_at_point")
	purego.RegisterLibFunc(&b.atspiActionDoAction, b.libatspi, "atspi_action_do_action")
	purego.RegisterLibFunc(&b.atspiRoleGetName, b.libatspi, "atspi_role_get_name")

	// Register GLib functions
	purego.RegisterLibFunc(&b.gErrorFree, b.libglib, "g_error_free")
	purego.RegisterLibFunc(&b.gObjectUnref, b.libgobject, "g_object_unref")
	purego.RegisterLibFunc(&b.gFree, b.libglib, "g_free")

	// Initialize AT-SPI
	if result := b.atspiInit(); result != 0 {
		return nil, fmt.Errorf("atspi_init failed with code %d", result)
	}

	return b, nil
}

func (b *linuxBackend) GetTree() (*Node, error) {
	desktopCount := b.atspiGetDesktopCount()
	if desktopCount == 0 {
		return nil, fmt.Errorf("no desktops available")
	}

	// Get the first desktop
	desktop := b.atspiGetDesktop(0)
	if desktop == 0 {
		return nil, fmt.Errorf("failed to get desktop")
	}
	defer b.gObjectUnref(desktop)

	return b.accessibleToNode(desktop, 3)
}

func (b *linuxBackend) GetNodeByID(id string) (*Node, error) {
	// Use coordinates as ID
	var x, y int32
	_, err := fmt.Sscanf(id, "%d,%d", &x, &y)
	if err != nil {
		return nil, fmt.Errorf("invalid node ID format: %w", err)
	}

	// Get desktop
	desktop := b.atspiGetDesktop(0)
	if desktop == 0 {
		return nil, fmt.Errorf("failed to get desktop")
	}
	defer b.gObjectUnref(desktop)

	// Get component interface
	component := b.atspiAccessibleGetComponentIface(desktop)
	if component == 0 {
		return nil, fmt.Errorf("desktop has no component interface")
	}

	// Get accessible at point
	var gerror uintptr
	accessible := b.atspiComponentGetAccessibleAtPoint(component, x, y, atspiCoordTypeScreen, &gerror)
	if gerror != 0 {
		b.gErrorFree(gerror)
		return nil, fmt.Errorf("failed to get accessible at point")
	}
	if accessible == 0 {
		return nil, fmt.Errorf("no accessible at position %s", id)
	}
	defer b.gObjectUnref(accessible)

	return b.accessibleToNode(accessible, 0)
}

func (b *linuxBackend) PerformAction(id string, action string) error {
	var x, y int32
	_, err := fmt.Sscanf(id, "%d,%d", &x, &y)
	if err != nil {
		return fmt.Errorf("invalid node ID format: %w", err)
	}

	// Get desktop
	desktop := b.atspiGetDesktop(0)
	if desktop == 0 {
		return fmt.Errorf("failed to get desktop")
	}
	defer b.gObjectUnref(desktop)

	// Get component interface
	component := b.atspiAccessibleGetComponentIface(desktop)
	if component == 0 {
		return fmt.Errorf("desktop has no component interface")
	}

	// Get accessible at point
	var gerror uintptr
	accessible := b.atspiComponentGetAccessibleAtPoint(component, x, y, atspiCoordTypeScreen, &gerror)
	if gerror != 0 {
		b.gErrorFree(gerror)
		return fmt.Errorf("failed to get accessible at point")
	}
	if accessible == 0 {
		return fmt.Errorf("no accessible at position %s", id)
	}
	defer b.gObjectUnref(accessible)

	// Perform action (index 0 is usually the default action like "click")
	gerror = 0
	if !b.atspiActionDoAction(accessible, 0, &gerror) {
		if gerror != 0 {
			b.gErrorFree(gerror)
		}
		return fmt.Errorf("failed to perform action %s", action)
	}

	return nil
}

func (b *linuxBackend) accessibleToNode(accessible uintptr, depth int) (*Node, error) {
	if accessible == 0 {
		return nil, fmt.Errorf("null accessible")
	}

	node := &Node{}

	// Get role
	var gerror uintptr
	role := b.atspiAccessibleGetRole(accessible, &gerror)
	if gerror != 0 {
		b.gErrorFree(gerror)
		gerror = 0
	}

	roleNamePtr := b.atspiRoleGetName(role)
	if roleNamePtr != 0 {
		node.Role = goStringFromCString(roleNamePtr)
	}

	// Get name
	namePtr := b.atspiAccessibleGetName(accessible, &gerror)
	if gerror != 0 {
		b.gErrorFree(gerror)
		gerror = 0
	}
	if namePtr != 0 {
		node.Name = goStringFromCString(namePtr)
		b.gFree(namePtr)
	}

	// Get description
	descPtr := b.atspiAccessibleGetDescription(accessible, &gerror)
	if gerror != 0 {
		b.gErrorFree(gerror)
		gerror = 0
	}
	if descPtr != 0 {
		node.Description = goStringFromCString(descPtr)
		b.gFree(descPtr)
	}

	// Get component interface for bounds
	component := b.atspiAccessibleGetComponentIface(accessible)
	if component != 0 {
		extentsPtr := b.atspiComponentGetExtents(component, atspiCoordTypeScreen, &gerror)
		if gerror != 0 {
			b.gErrorFree(gerror)
			gerror = 0
		}
		if extentsPtr != 0 {
			// AtspiRect struct: {x, y, width, height} as int32
			// Store intermediate pointer to satisfy go vet's conversion rules
			var rectPtr unsafe.Pointer = unsafe.Pointer(extentsPtr) // #nosec G103
			rect := unsafe.Slice((*int32)(rectPtr), 4)
			node.BoundingBox[0] = int(rect[0])
			node.BoundingBox[1] = int(rect[1])
			node.BoundingBox[2] = int(rect[2])
			node.BoundingBox[3] = int(rect[3])
			b.gFree(extentsPtr)

			// Use center of bounding box as ID
			node.ID = fmt.Sprintf("%d,%d", node.BoundingBox[0]+node.BoundingBox[2]/2, node.BoundingBox[1]+node.BoundingBox[3]/2)
		}
	}

	// Get state set for enabled/focused
	stateSet := b.atspiAccessibleGetStateSet(accessible, &gerror)
	if gerror != 0 {
		b.gErrorFree(gerror)
		gerror = 0
	}
	if stateSet != 0 {
		// TODO: Actually query the state set - for now assume enabled
		node.Enabled = true
		node.Focused = false
		b.gObjectUnref(stateSet)
	}

	// Get children if depth allows
	if depth > 0 {
		childCount := b.atspiAccessibleGetChildCount(accessible, &gerror)
		if gerror != 0 {
			b.gErrorFree(gerror)
			gerror = 0
		}

		if childCount > 0 {
			children := make([]*Node, 0, childCount)
			for i := int32(0); i < childCount; i++ {
				child := b.atspiAccessibleGetChildAtIndex(accessible, i, &gerror)
				if gerror != 0 {
					b.gErrorFree(gerror)
					gerror = 0
					continue
				}
				if child == 0 {
					continue
				}

				childNode, err := b.accessibleToNode(child, depth-1)
				b.gObjectUnref(child) // Release the child reference
				if err == nil {
					children = append(children, childNode)
				}
			}
			node.Children = children
		}
	}

	return node, nil
}

func goStringFromCString(ptr uintptr) string {
	if ptr == 0 {
		return ""
	}

	// Convert uintptr to unsafe.Pointer with intermediate variable
	var p unsafe.Pointer = unsafe.Pointer(ptr) // #nosec G103

	// Find null terminator
	var length int
	for i := 0; ; i++ {
		offset := unsafe.Add(p, i)
		b := *(*byte)(offset)
		if b == 0 {
			break
		}
		length++
		if length > 10000 { // Safety limit
			break
		}
	}

	if length == 0 {
		return ""
	}

	// Copy bytes to slice
	bytes := unsafe.Slice((*byte)(p), length) // #nosec G103
	return string(bytes)
}

func (b *linuxBackend) Close() error {
	// No persistent resources to clean up
	return nil
}

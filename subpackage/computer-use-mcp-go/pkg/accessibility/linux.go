// +build linux

package accessibility

/*
#cgo pkg-config: atspi-2
#include <atspi/atspi.h>
#include <stdlib.h>

// Helper to get desktop count
int getDesktopCount() {
    return atspi_get_desktop_count();
}

// Helper to get desktop
AtspiAccessible* getDesktop(int index) {
    return atspi_get_desktop(index);
}

// Helper to get child count
int getChildCount(AtspiAccessible* obj) {
    GError* error = NULL;
    int count = atspi_accessible_get_child_count(obj, &error);
    if (error) {
        g_error_free(error);
        return 0;
    }
    return count;
}

// Helper to get child at index
AtspiAccessible* getChildAtIndex(AtspiAccessible* obj, int index) {
    GError* error = NULL;
    AtspiAccessible* child = atspi_accessible_get_child_at_index(obj, index, &error);
    if (error) {
        g_error_free(error);
        return NULL;
    }
    return child;
}

// Helper to get component interface
AtspiComponent* getComponent(AtspiAccessible* obj) {
    return atspi_accessible_get_component_iface(obj);
}

// Helper to get extents
int getExtents(AtspiComponent* component, int* x, int* y, int* width, int* height) {
    GError* error = NULL;
    AtspiRect* rect = atspi_component_get_extents(component, ATSPI_COORD_TYPE_SCREEN, &error);
    if (error || !rect) {
        if (error) g_error_free(error);
        return 0;
    }
    *x = rect->x;
    *y = rect->y;
    *width = rect->width;
    *height = rect->height;
    g_free(rect);
    return 1;
}

// Helper to get role
int getRole(AtspiAccessible* obj) {
    return atspi_accessible_get_role(obj, NULL);
}

// Helper to get role name
const char* getRoleName(AtspiAccessible* obj) {
    GError* error = NULL;
    AtspiRole role = atspi_accessible_get_role(obj, &error);
    if (error) {
        g_error_free(error);
        return "unknown";
    }
    return atspi_role_get_name(role);
}

// Helper to get state set
AtspiStateSet* getStateSet(AtspiAccessible* obj) {
    GError* error = NULL;
    AtspiStateSet* states = atspi_accessible_get_state_set(obj);
    if (error) {
        g_error_free(error);
        return NULL;
    }
    return states;
}

// Helper to check if state set contains state
int stateSetContains(AtspiStateSet* set, AtspiStateType state) {
    if (!set) return 0;
    return atspi_state_set_contains(set, state);
}

// Helper to get name
char* getName(AtspiAccessible* obj) {
    GError* error = NULL;
    char* name = atspi_accessible_get_name(obj, &error);
    if (error) {
        g_error_free(error);
        return NULL;
    }
    return name;
}

// Helper to get description
char* getDescription(AtspiAccessible* obj) {
    GError* error = NULL;
    char* desc = atspi_accessible_get_description(obj, &error);
    if (error) {
        g_error_free(error);
        return NULL;
    }
    return desc;
}

// Helper to do action
int doAction(AtspiAccessible* obj, int actionIndex) {
    GError* error = NULL;
    AtspiAction* action = atspi_accessible_get_action_iface(obj);
    if (!action) return 0;

    gboolean result = atspi_action_do_action(action, actionIndex, &error);
    if (error) {
        g_error_free(error);
        return 0;
    }
    return result ? 1 : 0;
}

// Helper to get accessible at point
AtspiAccessible* getAccessibleAtPoint(int x, int y) {
    GError* error = NULL;
    int desktopCount = atspi_get_desktop_count();

    for (int i = 0; i < desktopCount; i++) {
        AtspiAccessible* desktop = atspi_get_desktop(i);
        if (!desktop) continue;

        AtspiComponent* component = atspi_accessible_get_component_iface(desktop);
        if (component) {
            AtspiAccessible* accessible = atspi_component_get_accessible_at_point(
                component, x, y, ATSPI_COORD_TYPE_SCREEN, &error);
            if (error) {
                g_error_free(error);
                error = NULL;
                continue;
            }
            if (accessible) return accessible;
        }
    }
    return NULL;
}
*/
import "C"
import (
	"fmt"
	"unsafe"
)

type linuxBackend struct {
	initialized bool
}

func newLinuxBackend() (*linuxBackend, error) {
	// Initialize AT-SPI
	result := C.atspi_init()
	if result != 0 {
		return nil, fmt.Errorf("failed to initialize AT-SPI")
	}

	return &linuxBackend{initialized: true}, nil
}

func (b *linuxBackend) GetTree() (*Node, error) {
	if !b.initialized {
		return nil, fmt.Errorf("backend not initialized")
	}

	desktopCount := int(C.getDesktopCount())
	if desktopCount == 0 {
		return nil, fmt.Errorf("no accessible desktops found")
	}

	// Get first desktop as root
	desktop := C.getDesktop(0)
	if desktop == nil {
		return nil, fmt.Errorf("failed to get desktop")
	}

	return b.accessibleToNode(desktop, 3) // Default depth 3
}

func (b *linuxBackend) GetNodeByID(id string) (*Node, error) {
	if !b.initialized {
		return nil, fmt.Errorf("backend not initialized")
	}

	// Parse "x,y" format
	var x, y int
	_, err := fmt.Sscanf(id, "%d,%d", &x, &y)
	if err != nil {
		return nil, fmt.Errorf("invalid node ID format: %v", err)
	}

	accessible := C.getAccessibleAtPoint(C.int(x), C.int(y))
	if accessible == nil {
		return nil, fmt.Errorf("no accessible at position %s", id)
	}

	return b.accessibleToNode(accessible, 0) // No children for point queries
}

func (b *linuxBackend) PerformAction(id string, action string) error {
	if !b.initialized {
		return fmt.Errorf("backend not initialized")
	}

	var x, y int
	_, err := fmt.Sscanf(id, "%d,%d", &x, &y)
	if err != nil {
		return fmt.Errorf("invalid node ID format: %v", err)
	}

	accessible := C.getAccessibleAtPoint(C.int(x), C.int(y))
	if accessible == nil {
		return fmt.Errorf("no accessible at position %s", id)
	}

	// Default action is index 0 (usually "click" or "activate")
	success := C.doAction(accessible, 0)
	if success == 0 {
		return fmt.Errorf("action failed")
	}

	return nil
}

func (b *linuxBackend) accessibleToNode(accessible *C.AtspiAccessible, depth uint32) (*Node, error) {
	if accessible == nil {
		return nil, fmt.Errorf("null accessible")
	}

	node := &Node{
		Attributes: make(map[string]string),
	}

	// Get role name
	if roleName := C.getRoleName(accessible); roleName != nil {
		node.Role = C.GoString(roleName)
	}

	// Get name
	if name := C.getName(accessible); name != nil {
		node.Name = C.GoString(name)
		C.free(unsafe.Pointer(name))
	}

	// Get description (used as value)
	if desc := C.getDescription(accessible); desc != nil {
		node.Value = C.GoString(desc)
		C.free(unsafe.Pointer(desc))
	}

	// Get state set
	stateSet := C.getStateSet(accessible)
	if stateSet != nil {
		node.Enabled = C.stateSetContains(stateSet, C.ATSPI_STATE_ENABLED) != 0
		node.Focused = C.stateSetContains(stateSet, C.ATSPI_STATE_FOCUSED) != 0
		C.g_object_unref(C.gpointer(unsafe.Pointer(stateSet)))
	}

	// Get bounds
	component := C.getComponent(accessible)
	if component != nil {
		var x, y, width, height C.int
		if C.getExtents(component, &x, &y, &width, &height) != 0 {
			node.Bounds = Bounds{
				X:      int(x),
				Y:      int(y),
				Width:  int(width),
				Height: int(height),
			}
			// Use center coordinates as ID
			node.ID = fmt.Sprintf("%d,%d", int(x)+int(width)/2, int(y)+int(height)/2)
		}
	}

	// Get children if depth > 0
	if depth > 0 {
		childCount := int(C.getChildCount(accessible))
		if childCount > 0 && childCount < 100 { // Limit to 100 children
			node.Children = make([]*Node, 0, childCount)
			for i := 0; i < childCount; i++ {
				child := C.getChildAtIndex(accessible, C.int(i))
				if child != nil {
					if childNode, err := b.accessibleToNode(child, depth-1); err == nil {
						node.Children = append(node.Children, childNode)
					}
				}
			}
		}
	}

	return node, nil
}

func (b *linuxBackend) Close() error {
	if b.initialized {
		C.atspi_exit()
		b.initialized = false
	}
	return nil
}

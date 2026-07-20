//go:build darwin

package accessibility

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework ApplicationServices -framework Foundation

#include <ApplicationServices/ApplicationServices.h>
#include <Foundation/Foundation.h>

// Helper to get AX element at position
AXUIElementRef getElementAtPosition(float x, float y) {
    AXUIElementRef systemWide = AXUIElementCreateSystemWide();
    AXUIElementRef element = NULL;

    CGPoint point = CGPointMake(x, y);
    AXUIElementCopyElementAtPosition(systemWide, point.x, point.y, &element);

    CFRelease(systemWide);
    return element;
}

// Helper to get focused element
AXUIElementRef getFocusedElement() {
    AXUIElementRef systemWide = AXUIElementCreateSystemWide();
    AXUIElementRef focusedApp = NULL;
    AXUIElementRef focusedElement = NULL;

    AXUIElementCopyAttributeValue(systemWide, kAXFocusedApplicationAttribute, (CFTypeRef*)&focusedApp);
    if (focusedApp) {
        AXUIElementCopyAttributeValue(focusedApp, kAXFocusedUIElementAttribute, (CFTypeRef*)&focusedElement);
        CFRelease(focusedApp);
    }

    CFRelease(systemWide);
    return focusedElement;
}

// Helper to get attribute string value
char* getStringAttribute(AXUIElementRef element, CFStringRef attribute) {
    CFTypeRef value = NULL;
    if (AXUIElementCopyAttributeValue(element, attribute, &value) == kAXErrorSuccess && value) {
        if (CFGetTypeID(value) == CFStringGetTypeID()) {
            CFStringRef str = (CFStringRef)value;
            CFIndex length = CFStringGetLength(str);
            CFIndex maxSize = CFStringGetMaximumSizeForEncoding(length, kCFStringEncodingUTF8) + 1;
            char* buffer = malloc(maxSize);
            if (CFStringGetCString(str, buffer, maxSize, kCFStringEncodingUTF8)) {
                CFRelease(value);
                return buffer;
            }
            free(buffer);
        }
        CFRelease(value);
    }
    return NULL;
}

// Helper to get bounds
int getBounds(AXUIElementRef element, float* x, float* y, float* width, float* height) {
    CFTypeRef posValue = NULL;
    CFTypeRef sizeValue = NULL;

    if (AXUIElementCopyAttributeValue(element, kAXPositionAttribute, &posValue) == kAXErrorSuccess && posValue) {
        CGPoint point;
        if (AXValueGetValue(posValue, kAXValueCGPointType, &point)) {
            *x = point.x;
            *y = point.y;
        }
        CFRelease(posValue);
    }

    if (AXUIElementCopyAttributeValue(element, kAXSizeAttribute, &sizeValue) == kAXErrorSuccess && sizeValue) {
        CGSize size;
        if (AXValueGetValue(sizeValue, kAXValueCGSizeType, &size)) {
            *width = size.width;
            *height = size.height;
        }
        CFRelease(sizeValue);
    }

    return 1;
}

// Helper to get boolean attribute
int getBoolAttribute(AXUIElementRef element, CFStringRef attribute) {
    CFTypeRef value = NULL;
    int result = 0;
    if (AXUIElementCopyAttributeValue(element, attribute, &value) == kAXErrorSuccess && value) {
        if (CFGetTypeID(value) == CFBooleanGetTypeID()) {
            result = CFBooleanGetValue((CFBooleanRef)value) ? 1 : 0;
        }
        CFRelease(value);
    }
    return result;
}

// Helper to get children count
int getChildrenCount(AXUIElementRef element) {
    CFTypeRef children = NULL;
    int count = 0;
    if (AXUIElementCopyAttributeValue(element, kAXChildrenAttribute, &children) == kAXErrorSuccess && children) {
        if (CFGetTypeID(children) == CFArrayGetTypeID()) {
            count = CFArrayGetCount((CFArrayRef)children);
        }
        CFRelease(children);
    }
    return count;
}

// Helper to get child at index
AXUIElementRef getChildAtIndex(AXUIElementRef element, int index) {
    CFTypeRef children = NULL;
    AXUIElementRef child = NULL;

    if (AXUIElementCopyAttributeValue(element, kAXChildrenAttribute, &children) == kAXErrorSuccess && children) {
        if (CFGetTypeID(children) == CFArrayGetTypeID()) {
            CFArrayRef childArray = (CFArrayRef)children;
            if (index >= 0 && index < CFArrayGetCount(childArray)) {
                child = (AXUIElementRef)CFArrayGetValueAtIndex(childArray, index);
                if (child) {
                    CFRetain(child);  // Retain so caller can release
                }
            }
        }
        CFRelease(children);
    }

    return child;
}

// Helper to perform action
int performAction(AXUIElementRef element, const char* actionName) {
    CFStringRef action = CFStringCreateWithCString(NULL, actionName, kCFStringEncodingUTF8);
    AXError error = AXUIElementPerformAction(element, action);
    CFRelease(action);
    return error == kAXErrorSuccess ? 1 : 0;
}
*/
import "C"
import (
	"fmt"
	"unsafe"
)

type darwinBackend struct {
	// No persistent state needed for macOS
}

func newDarwinBackend() (*darwinBackend, error) {
	// Check if we have accessibility permission
	trusted := C.AXIsProcessTrusted()
	if !trusted {
		return nil, fmt.Errorf("accessibility permission not granted")
	}

	return &darwinBackend{}, nil
}

func (b *darwinBackend) GetTree() (*Node, error) {
	// Get focused element as root
	element := C.getFocusedElement()
	if element == nil {
		return nil, fmt.Errorf("no focused element")
	}
	defer C.CFRelease(C.CFTypeRef(element))

	return b.elementToNode(element, 3) // Default depth 3
}

func (b *darwinBackend) GetNodeByID(id string) (*Node, error) {
	// For simplicity, we use screen coordinates as ID
	// Parse "x,y" format
	var x, y float32
	_, err := fmt.Sscanf(id, "%f,%f", &x, &y)
	if err != nil {
		return nil, fmt.Errorf("invalid node ID format: %v", err)
	}

	element := C.getElementAtPosition(C.float(x), C.float(y))
	if element == nil {
		return nil, fmt.Errorf("no element at position %s", id)
	}
	defer C.CFRelease(C.CFTypeRef(element))

	return b.elementToNode(element, 0) // No children for point queries
}

func (b *darwinBackend) PerformAction(id string, action string) error {
	var x, y float32
	_, err := fmt.Sscanf(id, "%f,%f", &x, &y)
	if err != nil {
		return fmt.Errorf("invalid node ID format: %v", err)
	}

	element := C.getElementAtPosition(C.float(x), C.float(y))
	if element == nil {
		return fmt.Errorf("no element at position %s", id)
	}
	defer C.CFRelease(C.CFTypeRef(element))

	actionCStr := C.CString(action)
	defer C.free(unsafe.Pointer(actionCStr))

	success := C.performAction(element, actionCStr)
	if success == 0 {
		return fmt.Errorf("action %s failed", action)
	}

	return nil
}

func (b *darwinBackend) elementToNode(element C.AXUIElementRef, depth uint32) (*Node, error) {
	node := &Node{
		Attributes: make(map[string]string),
	}

	// Get role
	if role := C.getStringAttribute(element, C.CFStringRef(C.kAXRoleAttribute)); role != nil {
		node.Role = C.GoString(role)
		C.free(unsafe.Pointer(role))
	}

	// Get title/name
	if title := C.getStringAttribute(element, C.CFStringRef(C.kAXTitleAttribute)); title != nil {
		node.Name = C.GoString(title)
		C.free(unsafe.Pointer(title))
	}

	// Get description
	if desc := C.getStringAttribute(element, C.CFStringRef(C.kAXDescriptionAttribute)); desc != nil {
		node.Description = C.GoString(desc)
		C.free(unsafe.Pointer(desc))
	}

	// Get value
	if value := C.getStringAttribute(element, C.CFStringRef(C.kAXValueAttribute)); value != nil {
		node.Value = C.GoString(value)
		C.free(unsafe.Pointer(value))
	}

	// Get enabled state
	node.Enabled = C.getBoolAttribute(element, C.CFStringRef(C.kAXEnabledAttribute)) != 0

	// Get focused state
	node.Focused = C.getBoolAttribute(element, C.CFStringRef(C.kAXFocusedAttribute)) != 0

	// Get bounds
	var x, y, width, height C.float
	C.getBounds(element, &x, &y, &width, &height)
	node.Bounds = Bounds{
		X:      int(x),
		Y:      int(y),
		Width:  int(width),
		Height: int(height),
	}

	// Use center coordinates as ID
	node.ID = fmt.Sprintf("%d,%d", int(x)+int(width)/2, int(y)+int(height)/2)

	// Get children if depth > 0
	if depth > 0 {
		childCount := int(C.getChildrenCount(element))
		if childCount > 0 {
			node.Children = make([]*Node, 0, childCount)
			for i := 0; i < childCount; i++ {
				child := C.getChildAtIndex(element, C.int(i))
				if child != nil {
					if childNode, err := b.elementToNode(child, depth-1); err == nil {
						node.Children = append(node.Children, childNode)
					}
					C.CFRelease(C.CFTypeRef(child))
				}
			}
		}
	}

	return node, nil
}

func (b *darwinBackend) Close() error {
	return nil
}

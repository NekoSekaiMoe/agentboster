//go:build darwin

package accessibility

import (
	"fmt"
	"unsafe"

	"github.com/ebitengine/purego"
)

type darwinBackend struct {
	// Loaded libraries
	appServices     uintptr
	coreFoundation  uintptr

	// AX functions
	axIsProcessTrusted              func() bool
	axUIElementCreateSystemWide     func() uintptr
	axUIElementCopyElementAtPosition func(element uintptr, x float32, y float32, outElement *uintptr) int32
	axUIElementCopyAttributeValue   func(element uintptr, attribute uintptr, value *uintptr) int32
	axUIElementPerformAction        func(element uintptr, action uintptr) int32

	// CF functions
	cfRelease                    func(cf uintptr)
	cfRetain                     func(cf uintptr) uintptr
	cfStringCreateWithCString    func(alloc uintptr, cStr *byte, encoding uint32) uintptr
	cfStringGetCString           func(theString uintptr, buffer *byte, bufferSize int64, encoding uint32) bool
	cfStringGetLength            func(theString uintptr) int64
	cfStringGetMaximumSizeForEncoding func(theString uintptr, encoding uint32) int64
	cfArrayGetCount              func(array uintptr) int64
	cfArrayGetValueAtIndex       func(array uintptr, idx int64) uintptr
	cfBooleanGetValue            func(boolean uintptr) bool
	cfGetTypeID                  func(cf uintptr) uint64
	cfStringGetTypeID            func() uint64
	cfArrayGetTypeID             func() uint64
	cfBooleanGetTypeID           func() uint64
	axValueGetValue              func(value uintptr, theType int32, valuePtr unsafe.Pointer) bool

	// Cached attribute strings
	kAXFocusedApplicationAttribute uintptr
	kAXFocusedUIElementAttribute   uintptr
	kAXRoleAttribute               uintptr
	kAXTitleAttribute              uintptr
	kAXDescriptionAttribute        uintptr
	kAXPositionAttribute           uintptr
	kAXSizeAttribute               uintptr
	kAXEnabledAttribute            uintptr
	kAXFocusedAttribute            uintptr
	kAXChildrenAttribute           uintptr
	kAXPressAction                 uintptr
}

const (
	kCFStringEncodingUTF8 uint32 = 0x08000100
	kAXErrorSuccess       int32  = 0
	kAXValueCGPointType   int32  = 1
	kAXValueCGSizeType    int32  = 2
)

type cgPoint struct {
	x, y float64
}

type cgSize struct {
	width, height float64
}

func newDarwinBackend() (*darwinBackend, error) {
	b := &darwinBackend{}

	var err error
	b.appServices, err = purego.Dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		return nil, fmt.Errorf("failed to load ApplicationServices: %w", err)
	}

	b.coreFoundation, err = purego.Dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		return nil, fmt.Errorf("failed to load CoreFoundation: %w", err)
	}

	// Register AX functions
	purego.RegisterLibFunc(&b.axIsProcessTrusted, b.appServices, "AXIsProcessTrusted")
	purego.RegisterLibFunc(&b.axUIElementCreateSystemWide, b.appServices, "AXUIElementCreateSystemWide")
	purego.RegisterLibFunc(&b.axUIElementCopyElementAtPosition, b.appServices, "AXUIElementCopyElementAtPosition")
	purego.RegisterLibFunc(&b.axUIElementCopyAttributeValue, b.appServices, "AXUIElementCopyAttributeValue")
	purego.RegisterLibFunc(&b.axUIElementPerformAction, b.appServices, "AXUIElementPerformAction")

	// Register CF functions
	purego.RegisterLibFunc(&b.cfRelease, b.coreFoundation, "CFRelease")
	purego.RegisterLibFunc(&b.cfRetain, b.coreFoundation, "CFRetain")
	purego.RegisterLibFunc(&b.cfStringCreateWithCString, b.coreFoundation, "CFStringCreateWithCString")
	purego.RegisterLibFunc(&b.cfStringGetCString, b.coreFoundation, "CFStringGetCString")
	purego.RegisterLibFunc(&b.cfStringGetLength, b.coreFoundation, "CFStringGetLength")
	purego.RegisterLibFunc(&b.cfStringGetMaximumSizeForEncoding, b.coreFoundation, "CFStringGetMaximumSizeForEncoding")
	purego.RegisterLibFunc(&b.cfArrayGetCount, b.coreFoundation, "CFArrayGetCount")
	purego.RegisterLibFunc(&b.cfArrayGetValueAtIndex, b.coreFoundation, "CFArrayGetValueAtIndex")
	purego.RegisterLibFunc(&b.cfBooleanGetValue, b.coreFoundation, "CFBooleanGetValue")
	purego.RegisterLibFunc(&b.cfGetTypeID, b.coreFoundation, "CFGetTypeID")
	purego.RegisterLibFunc(&b.cfStringGetTypeID, b.coreFoundation, "CFStringGetTypeID")
	purego.RegisterLibFunc(&b.cfArrayGetTypeID, b.coreFoundation, "CFArrayGetTypeID")
	purego.RegisterLibFunc(&b.cfBooleanGetTypeID, b.coreFoundation, "CFBooleanGetTypeID")
	purego.RegisterLibFunc(&b.axValueGetValue, b.appServices, "AXValueGetValue")

	// Check accessibility permission
	if !b.axIsProcessTrusted() {
		return nil, fmt.Errorf("accessibility permission not granted")
	}

	// Cache attribute strings
	b.kAXFocusedApplicationAttribute = b.createCFString("AXFocusedApplication")
	b.kAXFocusedUIElementAttribute = b.createCFString("AXFocusedUIElement")
	b.kAXRoleAttribute = b.createCFString("AXRole")
	b.kAXTitleAttribute = b.createCFString("AXTitle")
	b.kAXDescriptionAttribute = b.createCFString("AXDescription")
	b.kAXPositionAttribute = b.createCFString("AXPosition")
	b.kAXSizeAttribute = b.createCFString("AXSize")
	b.kAXEnabledAttribute = b.createCFString("AXEnabled")
	b.kAXFocusedAttribute = b.createCFString("AXFocused")
	b.kAXChildrenAttribute = b.createCFString("AXChildren")
	b.kAXPressAction = b.createCFString("AXPress")

	return b, nil
}

func (b *darwinBackend) createCFString(s string) uintptr {
	cstr := append([]byte(s), 0)
	return b.cfStringCreateWithCString(0, &cstr[0], kCFStringEncodingUTF8)
}

func (b *darwinBackend) cfStringToGo(cfStr uintptr) string {
	if cfStr == 0 {
		return ""
	}

	length := b.cfStringGetLength(cfStr)
	if length == 0 {
		return ""
	}

	// CFStringGetLength returns the number of UTF-16 code units, NOT the
	// UTF-8 byte count. Size the buffer using the worst-case UTF-8 expansion
	// (CFStringGetMaximumSizeForEncoding) plus one byte for the NUL terminator,
	// otherwise supplementary-plane characters (emoji, etc.) overflow the buffer.
	maxBytes := b.cfStringGetMaximumSizeForEncoding(cfStr, kCFStringEncodingUTF8)
	bufSize := maxBytes + 1
	if bufSize < 1 {
		// Defensive: overflow / negative — bail out rather than under-allocate.
		return ""
	}

	buf := make([]byte, bufSize)
	if !b.cfStringGetCString(cfStr, &buf[0], bufSize, kCFStringEncodingUTF8) {
		return ""
	}

	for i, b := range buf {
		if b == 0 {
			return string(buf[:i])
		}
	}
	return string(buf)
}

func (b *darwinBackend) GetTree() (*Node, error) {
	systemWide := b.axUIElementCreateSystemWide()
	if systemWide == 0 {
		return nil, fmt.Errorf("failed to create system-wide element")
	}
	defer b.cfRelease(systemWide)

	// Get focused application
	var focusedApp uintptr
	if b.axUIElementCopyAttributeValue(systemWide, b.kAXFocusedApplicationAttribute, &focusedApp) != kAXErrorSuccess || focusedApp == 0 {
		return nil, fmt.Errorf("no focused application")
	}
	defer b.cfRelease(focusedApp)

	// Get focused element
	var focusedElement uintptr
	if b.axUIElementCopyAttributeValue(focusedApp, b.kAXFocusedUIElementAttribute, &focusedElement) != kAXErrorSuccess || focusedElement == 0 {
		return nil, fmt.Errorf("no focused element")
	}
	defer b.cfRelease(focusedElement)

	return b.elementToNode(focusedElement, 3)
}

func (b *darwinBackend) GetNodeByID(id string) (*Node, error) {
	var x, y float32
	_, err := fmt.Sscanf(id, "%f,%f", &x, &y)
	if err != nil {
		return nil, fmt.Errorf("invalid node ID format: %w", err)
	}

	systemWide := b.axUIElementCreateSystemWide()
	if systemWide == 0 {
		return nil, fmt.Errorf("failed to create system-wide element")
	}
	defer b.cfRelease(systemWide)

	var element uintptr
	if b.axUIElementCopyElementAtPosition(systemWide, x, y, &element) != kAXErrorSuccess || element == 0 {
		return nil, fmt.Errorf("no element at position %s", id)
	}
	defer b.cfRelease(element)

	return b.elementToNode(element, 0)
}

func (b *darwinBackend) PerformAction(id string, action string) error {
	var x, y float32
	_, err := fmt.Sscanf(id, "%f,%f", &x, &y)
	if err != nil {
		return fmt.Errorf("invalid node ID format: %w", err)
	}

	systemWide := b.axUIElementCreateSystemWide()
	if systemWide == 0 {
		return fmt.Errorf("failed to create system-wide element")
	}
	defer b.cfRelease(systemWide)

	var element uintptr
	if b.axUIElementCopyElementAtPosition(systemWide, x, y, &element) != kAXErrorSuccess || element == 0 {
		return fmt.Errorf("no element at position %s", id)
	}
	defer b.cfRelease(element)

	var actionStr uintptr
	switch action {
	case "click":
		actionStr = b.kAXPressAction
	default:
		return fmt.Errorf("unsupported action: %s", action)
	}

	if b.axUIElementPerformAction(element, actionStr) != kAXErrorSuccess {
		return fmt.Errorf("failed to perform action %s", action)
	}

	return nil
}

func (b *darwinBackend) elementToNode(element uintptr, depth int) (*Node, error) {
	node := &Node{
		ID: b.getElementID(element),
	}

	// Get role
	var roleValue uintptr
	if b.axUIElementCopyAttributeValue(element, b.kAXRoleAttribute, &roleValue) == kAXErrorSuccess && roleValue != 0 {
		if b.cfGetTypeID(roleValue) == b.cfStringGetTypeID() {
			node.Role = b.cfStringToGo(roleValue)
		}
		b.cfRelease(roleValue)
	}

	// Get name/title
	var nameValue uintptr
	if b.axUIElementCopyAttributeValue(element, b.kAXTitleAttribute, &nameValue) == kAXErrorSuccess && nameValue != 0 {
		if b.cfGetTypeID(nameValue) == b.cfStringGetTypeID() {
			node.Name = b.cfStringToGo(nameValue)
		}
		b.cfRelease(nameValue)
	}

	// Get description
	var descValue uintptr
	if b.axUIElementCopyAttributeValue(element, b.kAXDescriptionAttribute, &descValue) == kAXErrorSuccess && descValue != 0 {
		if b.cfGetTypeID(descValue) == b.cfStringGetTypeID() {
			node.Description = b.cfStringToGo(descValue)
		}
		b.cfRelease(descValue)
	}

	// Get bounds
	var posValue uintptr
	if b.axUIElementCopyAttributeValue(element, b.kAXPositionAttribute, &posValue) == kAXErrorSuccess && posValue != 0 {
		var point cgPoint
		if b.axValueGetValue(posValue, kAXValueCGPointType, unsafe.Pointer(&point)) {
			node.BoundingBox[0] = int(point.x)
			node.BoundingBox[1] = int(point.y)
		}
		b.cfRelease(posValue)
	}

	var sizeValue uintptr
	if b.axUIElementCopyAttributeValue(element, b.kAXSizeAttribute, &sizeValue) == kAXErrorSuccess && sizeValue != 0 {
		var size cgSize
		if b.axValueGetValue(sizeValue, kAXValueCGSizeType, unsafe.Pointer(&size)) {
			node.BoundingBox[2] = int(size.width)
			node.BoundingBox[3] = int(size.height)
		}
		b.cfRelease(sizeValue)
	}

	// Get enabled state
	var enabledValue uintptr
	if b.axUIElementCopyAttributeValue(element, b.kAXEnabledAttribute, &enabledValue) == kAXErrorSuccess && enabledValue != 0 {
		if b.cfGetTypeID(enabledValue) == b.cfBooleanGetTypeID() {
			node.Enabled = b.cfBooleanGetValue(enabledValue)
		}
		b.cfRelease(enabledValue)
	}

	// Get focused state
	var focusedValue uintptr
	if b.axUIElementCopyAttributeValue(element, b.kAXFocusedAttribute, &focusedValue) == kAXErrorSuccess && focusedValue != 0 {
		if b.cfGetTypeID(focusedValue) == b.cfBooleanGetTypeID() {
			node.Focused = b.cfBooleanGetValue(focusedValue)
		}
		b.cfRelease(focusedValue)
	}

	// Get children if depth allows
	if depth > 0 {
		node.Children = b.getChildren(element, depth-1)
	}

	return node, nil
}

func (b *darwinBackend) getElementID(element uintptr) string {
	// Use position as ID
	var posValue uintptr
	if b.axUIElementCopyAttributeValue(element, b.kAXPositionAttribute, &posValue) == kAXErrorSuccess && posValue != 0 {
		var point cgPoint
		if b.axValueGetValue(posValue, kAXValueCGPointType, unsafe.Pointer(&point)) {
			b.cfRelease(posValue)
			return fmt.Sprintf("%.0f,%.0f", point.x, point.y)
		}
		b.cfRelease(posValue)
	}
	return ""
}

func (b *darwinBackend) getChildren(element uintptr, depth int) []*Node {
	var childrenValue uintptr
	if b.axUIElementCopyAttributeValue(element, b.kAXChildrenAttribute, &childrenValue) != kAXErrorSuccess || childrenValue == 0 {
		return nil
	}
	defer b.cfRelease(childrenValue)

	if b.cfGetTypeID(childrenValue) != b.cfArrayGetTypeID() {
		return nil
	}

	count := b.cfArrayGetCount(childrenValue)
	if count == 0 {
		return nil
	}

	children := make([]*Node, 0, count)
	for i := int64(0); i < count; i++ {
		child := b.cfArrayGetValueAtIndex(childrenValue, i)
		if child == 0 {
			continue
		}

		// Don't need to retain/release - the array owns the reference
		childNode, err := b.elementToNode(child, depth)
		if err == nil {
			children = append(children, childNode)
		}
	}

	return children
}

func (b *darwinBackend) Close() error {
	// Release cached attribute strings
	if b.kAXFocusedApplicationAttribute != 0 {
		b.cfRelease(b.kAXFocusedApplicationAttribute)
	}
	if b.kAXFocusedUIElementAttribute != 0 {
		b.cfRelease(b.kAXFocusedUIElementAttribute)
	}
	if b.kAXRoleAttribute != 0 {
		b.cfRelease(b.kAXRoleAttribute)
	}
	if b.kAXTitleAttribute != 0 {
		b.cfRelease(b.kAXTitleAttribute)
	}
	if b.kAXDescriptionAttribute != 0 {
		b.cfRelease(b.kAXDescriptionAttribute)
	}
	if b.kAXPositionAttribute != 0 {
		b.cfRelease(b.kAXPositionAttribute)
	}
	if b.kAXSizeAttribute != 0 {
		b.cfRelease(b.kAXSizeAttribute)
	}
	if b.kAXEnabledAttribute != 0 {
		b.cfRelease(b.kAXEnabledAttribute)
	}
	if b.kAXFocusedAttribute != 0 {
		b.cfRelease(b.kAXFocusedAttribute)
	}
	if b.kAXChildrenAttribute != 0 {
		b.cfRelease(b.kAXChildrenAttribute)
	}
	if b.kAXPressAction != 0 {
		b.cfRelease(b.kAXPressAction)
	}
	return nil
}

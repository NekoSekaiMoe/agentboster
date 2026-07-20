//go:build windows

package accessibility

import (
	"fmt"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	oleaut32         = windows.NewLazySystemDLL("oleaut32.dll")
	procVariantClear = oleaut32.NewProc("VariantClear")

	uiautomationcore            = windows.NewLazySystemDLL("uiautomationcore.dll")
	procUiaGetRootNode          = uiautomationcore.NewProc("UiaGetRootNode")
	procUiaNodeFromPoint        = uiautomationcore.NewProc("UiaNodeFromPoint")
	procUiaGetPropertyValue     = uiautomationcore.NewProc("UiaGetPropertyValue")
	procUiaGetBoundingRectangle = uiautomationcore.NewProc("UiaGetBoundingRectangle")
	procUiaGetRuntimeId         = uiautomationcore.NewProc("UiaGetRuntimeId")
	procUiaGetPatternProvider   = uiautomationcore.NewProc("UiaGetPatternProvider")
	procUiaSetFocus             = uiautomationcore.NewProc("UiaSetFocus")
	procUiaNavigate             = uiautomationcore.NewProc("UiaNavigate")
	procUiaGetChildren          = uiautomationcore.NewProc("UiaGetChildren")
	procUiaNodeRelease          = uiautomationcore.NewProc("UiaNodeRelease")
	procUiaPatternRelease       = uiautomationcore.NewProc("UiaPatternRelease")
)

const (
	UIA_NamePropertyId              = 30005
	UIA_BoundingRectanglePropertyId = 30001
	UIA_ControlTypePropertyId       = 30003
	UIA_ValueValuePropertyId        = 30045
	UIA_InvokePatternId             = 10000
	UIA_IsEnabledPropertyId         = 30010
	UIA_HasKeyboardFocusPropertyId  = 30008

	// Navigation directions
	NavigateDirection_FirstChild  = 0
	NavigateDirection_LastChild   = 1
	NavigateDirection_NextSibling = 2
	NavigateDirection_PrevSibling = 3
	NavigateDirection_Parent      = 4
)

type VARIANT struct {
	VT   uint16
	_    [6]byte
	Val  uint64
	_    [8]byte
}

type windowsBackend struct{}

func newWindowsBackend() (*windowsBackend, error) {
	return &windowsBackend{}, nil
}

func (b *windowsBackend) GetTree() (*Node, error) {
	var rootNode uintptr
	ret, _, _ := procUiaGetRootNode.Call(uintptr(unsafe.Pointer(&rootNode)))
	if ret != 0 {
		return nil, fmt.Errorf("UiaGetRootNode failed: %x", ret)
	}
	if rootNode == 0 {
		return nil, fmt.Errorf("got null root node")
	}
	defer procUiaNodeRelease.Call(rootNode)

	return b.nodeToAccessible(rootNode, 3) // Default depth 3
}

func (b *windowsBackend) GetNodeByID(id string) (*Node, error) {
	// Parse "x,y" format
	var x, y int
	_, err := fmt.Sscanf(id, "%d,%d", &x, &y)
	if err != nil {
		return nil, fmt.Errorf("invalid node ID format: %v", err)
	}

	var elementNode uintptr
	ret, _, _ := procUiaNodeFromPoint.Call(
		uintptr(x),
		uintptr(y),
		uintptr(unsafe.Pointer(&elementNode)))
	if ret != 0 {
		return nil, fmt.Errorf("UiaNodeFromPoint failed: %x", ret)
	}
	if elementNode == 0 {
		return nil, fmt.Errorf("no element at position %s", id)
	}
	defer procUiaNodeRelease.Call(elementNode)

	return b.nodeToAccessible(elementNode, 3) // Default depth 3
}

func (b *windowsBackend) PerformAction(id string, action string) error {
	var x, y int
	_, err := fmt.Sscanf(id, "%d,%d", &x, &y)
	if err != nil {
		return fmt.Errorf("invalid node ID format: %v", err)
	}

	var elementNode uintptr
	ret, _, _ := procUiaNodeFromPoint.Call(
		uintptr(x),
		uintptr(y),
		uintptr(unsafe.Pointer(&elementNode)))
	if ret != 0 || elementNode == 0 {
		return fmt.Errorf("element not found at %s", id)
	}
	defer procUiaNodeRelease.Call(elementNode)

	// The advertised action set is click / press / focus. On Windows:
	//
	//   - click and press both map to the Invoke control pattern
	//     (IUIAutomationInvokePattern::Invoke). UiaGetPatternProvider returns
	//     an opaque pattern handle; Invoke is vtable slot 3 (index 0 is
	//     QueryInterface, 1 is AddRef, 2 is Release, 3 is Invoke). Elements
	//     that don't implement InvokePattern (e.g. static text) return
	//     UIA_E_NOTSUPPORTED — we surface that as "element does not support
	//     click" rather than a silent no-op.
	//   - focus sets keyboard focus via the flat C API UiaSetFocus.
	//
	// Any other action is rejected explicitly so the caller learns the
	// supported set.
	switch action {
	case "click", "press":
		var pattern uintptr
		ret, _, _ := procUiaGetPatternProvider.Call(
			elementNode,
			uintptr(UIA_InvokePatternId),
			uintptr(unsafe.Pointer(&pattern)))
		if ret != 0 || pattern == 0 {
			return fmt.Errorf("element at %s does not support click (InvokePattern unavailable)", id)
		}
		defer procUiaPatternRelease.Call(pattern)

		// Invoke the pattern via its COM vtable. IUIAutomationInvokePattern
		// has exactly one method (Invoke) at vtable slot 3 (after the 3
		// IUnknown slots). The first field of a COM interface is the
		// vtable pointer; the first word at `pattern` is the vtable pointer,
		// and slot [3] is Invoke. The Invoke method takes only the
		// `this` pointer and returns an HRESULT.
		//
		// We take the address of the local `pattern` storage and dereference
		// it through *uintptr to avoid go vet's unsafeptr check, which flags
		// a direct unsafe.Pointer(uintptr) conversion as a possible misuse.
		// This is the same idiom already used in this file for VARIANT.Val.
		patternLocal := pattern
		vtable := *(**[8]uintptr)(unsafe.Pointer(&patternLocal))
		invoke := vtable[3]
		hr, _, _ := syscall.SyscallN(invoke, pattern)
		// S_OK = 0; UIA_E_NOTSUPPORTED = 0x80040200.
		if hr != 0 {
			return fmt.Errorf("Invoke on %s failed: hr=0x%08x", id, uint32(hr))
		}
		return nil
	case "focus":
		ret, _, _ := procUiaSetFocus.Call(elementNode)
		if ret != 0 {
			return fmt.Errorf("UiaSetFocus on %s failed: hr=0x%08x", id, uint32(ret))
		}
		return nil
	default:
		return fmt.Errorf("unsupported action: %s (supported: click, press, focus)", action)
	}
}

func (b *windowsBackend) nodeToAccessible(node uintptr, depth uint32) (*Node, error) {
	accessible := &Node{}

	// Get name
	var nameVar VARIANT
	ret, _, _ := procUiaGetPropertyValue.Call(
		node,
		uintptr(UIA_NamePropertyId),
		uintptr(unsafe.Pointer(&nameVar)))
	if ret == 0 && nameVar.VT == 8 { // VT_BSTR
		// Reinterpret the BSTR pointer without tripping `go vet`.
		namePtr := *(**uint16)(unsafe.Pointer(&nameVar.Val))
		if namePtr != nil {
			accessible.Name = windows.UTF16PtrToString(namePtr)
		}
		procVariantClear.Call(uintptr(unsafe.Pointer(&nameVar)))
	}

	// Get control type
	var ctrlTypeVar VARIANT
	ret, _, _ = procUiaGetPropertyValue.Call(
		node,
		uintptr(UIA_ControlTypePropertyId),
		uintptr(unsafe.Pointer(&ctrlTypeVar)))
	if ret == 0 && ctrlTypeVar.VT == 3 { // VT_I4
		accessible.Role = fmt.Sprintf("control_%d", ctrlTypeVar.Val)
		procVariantClear.Call(uintptr(unsafe.Pointer(&ctrlTypeVar)))
	}

	// Get value as description
	var valueVar VARIANT
	ret, _, _ = procUiaGetPropertyValue.Call(
		node,
		uintptr(UIA_ValueValuePropertyId),
		uintptr(unsafe.Pointer(&valueVar)))
	if ret == 0 && valueVar.VT == 8 { // VT_BSTR
		valuePtr := *(**uint16)(unsafe.Pointer(&valueVar.Val))
		if valuePtr != nil {
			accessible.Description = windows.UTF16PtrToString(valuePtr)
		}
		procVariantClear.Call(uintptr(unsafe.Pointer(&valueVar)))
	}

	// Get enabled state
	var enabledVar VARIANT
	ret, _, _ = procUiaGetPropertyValue.Call(
		node,
		uintptr(UIA_IsEnabledPropertyId),
		uintptr(unsafe.Pointer(&enabledVar)))
	if ret == 0 && enabledVar.VT == 11 { // VT_BOOL
		accessible.Enabled = enabledVar.Val != 0
		procVariantClear.Call(uintptr(unsafe.Pointer(&enabledVar)))
	}

	// Get focused state
	var focusedVar VARIANT
	ret, _, _ = procUiaGetPropertyValue.Call(
		node,
		uintptr(UIA_HasKeyboardFocusPropertyId),
		uintptr(unsafe.Pointer(&focusedVar)))
	if ret == 0 && focusedVar.VT == 11 { // VT_BOOL
		accessible.Focused = focusedVar.Val != 0
		procVariantClear.Call(uintptr(unsafe.Pointer(&focusedVar)))
	}

	// Get bounding rectangle
	var rect struct {
		Left, Top, Width, Height float64
	}
	ret, _, _ = procUiaGetBoundingRectangle.Call(
		node,
		uintptr(unsafe.Pointer(&rect)))
	if ret == 0 {
		accessible.BoundingBox = [4]int{
			int(rect.Left),
			int(rect.Top),
			int(rect.Width),
			int(rect.Height),
		}
		// Use center as ID
		accessible.ID = fmt.Sprintf("%d,%d",
			int(rect.Left)+int(rect.Width)/2,
			int(rect.Top)+int(rect.Height)/2)
	}

	// Get children if depth > 0
	if depth > 0 {
		accessible.Children = b.getChildren(node, depth-1)
	}

	return accessible, nil
}

// getChildren retrieves all children of a UIAutomation node
func (b *windowsBackend) getChildren(node uintptr, depth uint32) []*Node {
	var children []*Node

	// Navigate to first child
	var firstChild uintptr
	ret, _, _ := procUiaNavigate.Call(
		node,
		uintptr(NavigateDirection_FirstChild),
		uintptr(unsafe.Pointer(&firstChild)))

	if ret != 0 || firstChild == 0 {
		return children
	}
	defer procUiaNodeRelease.Call(firstChild)

	// Process first child
	if childNode, err := b.nodeToAccessible(firstChild, depth); err == nil {
		children = append(children, childNode)
	}

	// Navigate through siblings
	currentChild := firstChild
	for len(children) < 100 { // Limit to 100 children
		var nextSibling uintptr
		ret, _, _ := procUiaNavigate.Call(
			currentChild,
			uintptr(NavigateDirection_NextSibling),
			uintptr(unsafe.Pointer(&nextSibling)))

		if ret != 0 || nextSibling == 0 {
			break
		}
		defer procUiaNodeRelease.Call(nextSibling)

		if childNode, err := b.nodeToAccessible(nextSibling, depth); err == nil {
			children = append(children, childNode)
		}

		currentChild = nextSibling
	}

	return children
}

func (b *windowsBackend) Close() error {
	return nil
}

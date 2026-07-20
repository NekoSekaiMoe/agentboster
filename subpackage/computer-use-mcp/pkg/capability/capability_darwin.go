// +build darwin

package capability

import (
	"os"

	"github.com/ebitengine/purego"
)

var axIsProcessTrusted func() bool

func init() {
	appServicesLib, err := purego.Dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		return
	}
	purego.RegisterLibFunc(&axIsProcessTrusted, appServicesLib, "AXIsProcessTrusted")
}

func checkAccessibilityPermission() bool {
	if axIsProcessTrusted == nil {
		return false
	}
	return axIsProcessTrusted()
}

func checkAdminStatus() bool {
	return os.Geteuid() == 0
}

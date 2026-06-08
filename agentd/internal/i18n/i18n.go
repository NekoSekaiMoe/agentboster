package i18n

import (
	"embed"
	"encoding/json"
	"os"
	"strings"

	goi18n "github.com/nicksnyder/go-i18n/v2/i18n"
	"golang.org/x/text/language"
)

//go:embed locales/*.json
var localeFS embed.FS

var bundle = func() *goi18n.Bundle {
	b := goi18n.NewBundle(language.Chinese)
	b.RegisterUnmarshalFunc("json", json.Unmarshal)
	_, _ = b.LoadMessageFileFS(localeFS, "locales/en.json")
	_, _ = b.LoadMessageFileFS(localeFS, "locales/zh.json")
	return b
}()

func languageTag() string {
	lang := strings.TrimSpace(os.Getenv("AGENTD_LANG"))
	if lang == "" {
		return "zh"
	}
	return lang
}

func T(id string, data map[string]any) string {
	localizer := goi18n.NewLocalizer(bundle, languageTag(), "en")
	msg, err := localizer.Localize(&goi18n.LocalizeConfig{
		MessageID:    id,
		TemplateData: data,
	})
	if err != nil {
		return id
	}
	return msg
}

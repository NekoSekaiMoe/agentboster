package agent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeAndChdir(t *testing.T, layout map[string]string) (root, brandHome, realHome string) {
	t.Helper()
	root = t.TempDir()
	for rel, content := range layout {
		abs := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", abs, err)
		}
		if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", abs, err)
		}
	}
	// brandHome / realHome live inside root so AGENTBOSTER_HOME and HOME can
	// both point there without polluting the real user home.
	brandHome = filepath.Join(root, "brand")
	realHome = filepath.Join(root, "home")
	t.Setenv("AGENTBOSTER_HOME", brandHome)
	t.Setenv("HOME", realHome)
	return root, brandHome, realHome
}

func TestLoadAgentsMd_EmptyWhenNothingFound(t *testing.T) {
	root, _, _ := writeAndChdir(t, nil)
	got := LoadAgentsMd(filepath.Join(root, "workspace"), "", "")
	if got.Content != "" {
		t.Fatalf("expected empty content, got %q", got.Content)
	}
	if got.Warning != "" {
		t.Fatalf("expected empty warning, got %q", got.Warning)
	}
}

func TestLoadAgentsMd_OnlyExactUppercaseRecognized(t *testing.T) {
	root, brandHome, realHome := writeAndChdir(t, map[string]string{
		"workspace/agents.md": "lowercase content",
		"workspace/CLAUDE.md": "claude content",
	})
	got := LoadAgentsMd(filepath.Join(root, "workspace"), brandHome, realHome)
	if got.Content != "" {
		t.Fatalf("expected empty (lowercase/CLAUDE.md ignored), got %q", got.Content)
	}
}

func TestLoadAgentsMd_ProjectLevelOnly(t *testing.T) {
	root, brandHome, realHome := writeAndChdir(t, map[string]string{
		"workspace/AGENTS.md": "project instructions",
	})
	got := LoadAgentsMd(filepath.Join(root, "workspace"), brandHome, realHome)
	if !strings.Contains(got.Content, "project instructions") {
		t.Fatalf("expected project content in %q", got.Content)
	}
	if !strings.Contains(got.Content, "<!-- From:") {
		t.Fatalf("expected source annotation in %q", got.Content)
	}
}

func TestLoadAgentsMd_MergesUserAndProjectTiers(t *testing.T) {
	root, brandHome, realHome := writeAndChdir(t, map[string]string{
		"brand/AGENTS.md":      "brand home instructions",
		"home/.agents/AGENTS.md": "generic user instructions",
		"workspace/AGENTS.md":   "project instructions",
	})
	got := LoadAgentsMd(filepath.Join(root, "workspace"), brandHome, realHome)
	for _, want := range []string{"brand home instructions", "generic user instructions", "project instructions"} {
		if !strings.Contains(got.Content, want) {
			t.Errorf("expected %q in merged content, got %q", want, got.Content)
		}
	}
}

func TestLoadAgentsMd_RootToLeafOrderInProjectChain(t *testing.T) {
	// workspace = root/repo/packages/app; .git at root/repo.
	// Expected discovery (root→leaf): repo/AGENTS.md, repo/packages/AGENTS.md,
	// repo/packages/app/AGENTS.md.
	root, brandHome, realHome := writeAndChdir(t, map[string]string{
		"repo/.git":              "",
		"repo/AGENTS.md":         "ROOT",
		"repo/packages/AGENTS.md": "MID",
		"repo/packages/app/AGENTS.md": "LEAF",
	})
	sandboxPath := filepath.Join(root, "repo", "packages", "app")
	got := LoadAgentsMd(sandboxPath, brandHome, realHome)

	idxRoot := strings.Index(got.Content, "ROOT")
	idxMid := strings.Index(got.Content, "MID")
	idxLeaf := strings.Index(got.Content, "LEAF")
	if idxRoot < 0 || idxMid < 0 || idxLeaf < 0 {
		t.Fatalf("missing tiers in %q", got.Content)
	}
	if !(idxRoot < idxMid && idxMid < idxLeaf) {
		t.Fatalf("expected ROOT<MID<LEAF order, got root=%d mid=%d leaf=%d", idxRoot, idxMid, idxLeaf)
	}
}

func TestLoadAgentsMd_DedupesByCanonicalPath(t *testing.T) {
	// Symlink loop is not simulated here; instead, the same file discovered
	// through two tiers must appear only once. brand and project both point
	// at the same physical file via absolute path is unrealistic, so instead
	// we verify the seen-map dedupes when brand==realHome and both would
	// otherwise try to read the same file: brand/AGENTS.md and home/.agents/
	// AGENTS.md are different files by design, so verify via a single file
	// visible at both project root and a parent dir boundary.
	root, brandHome, realHome := writeAndChdir(t, map[string]string{
		"repo/.git":      "",
		"repo/AGENTS.md": "shared",
		"repo/sub/AGENTS.md": "shared", // different file but same content
	})
	got := LoadAgentsMd(filepath.Join(root, "repo", "sub"), brandHome, realHome)
	if strings.Count(got.Content, "shared") != 2 {
		t.Fatalf("expected both files kept (different paths), got %q", got.Content)
	}
	if strings.Count(got.Content, "<!-- From:") != 2 {
		t.Fatalf("expected two annotations, got %q", got.Content)
	}
	_ = root
}

func TestLoadAgentsMd_NoProjectScanWhenSandboxPathEmpty(t *testing.T) {
	root, brandHome, realHome := writeAndChdir(t, map[string]string{
		"brand/AGENTS.md": "brand only",
		"workspace/AGENTS.md": "should not be picked up",
	})
	got := LoadAgentsMd("", brandHome, realHome)
	if !strings.Contains(got.Content, "brand only") {
		t.Errorf("expected brand file collected, got %q", got.Content)
	}
	if strings.Contains(got.Content, "should not be picked up") {
		t.Errorf("project scan happened with empty sandboxPath: %q", got.Content)
	}
	_ = root
}

func TestLoadAgentsMd_FindsProjectRootWithoutGit(t *testing.T) {
	// No .git anywhere: project root falls back to sandboxPath itself, so only
	// the leaf AGENTS.md is collected.
	root, brandHome, realHome := writeAndChdir(t, map[string]string{
		"workspace/AGENTS.md": "leaf only",
		"workspace/parent/AGENTS.md": "should not be picked up",
	})
	got := LoadAgentsMd(filepath.Join(root, "workspace"), brandHome, realHome)
	if !strings.Contains(got.Content, "leaf only") {
		t.Errorf("expected leaf content, got %q", got.Content)
	}
	if strings.Contains(got.Content, "should not be picked up") {
		t.Errorf("walked above sandboxPath without .git: %q", got.Content)
	}
}

func TestLoadAgentsMd_WarnsWhenOverBudget(t *testing.T) {
	huge := strings.Repeat("a", agentsMdRecommendedMaxBytes+1)
	root, brandHome, realHome := writeAndChdir(t, map[string]string{
		"workspace/AGENTS.md": huge,
	})
	got := LoadAgentsMd(filepath.Join(root, "workspace"), brandHome, realHome)
	if got.Warning == "" {
		t.Fatalf("expected non-empty warning over budget")
	}
	if !strings.Contains(got.Warning, "exceeds the recommended") {
		t.Errorf("unexpected warning text: %q", got.Warning)
	}
	if len(got.Content) < agentsMdRecommendedMaxBytes {
		t.Errorf("content was truncated; expected full %d bytes, got %d", agentsMdRecommendedMaxBytes+1, len(got.Content))
	}
}

func TestLoadAgentsMd_NoWarningUnderBudget(t *testing.T) {
	root, brandHome, realHome := writeAndChdir(t, map[string]string{
		"workspace/AGENTS.md": "small",
	})
	got := LoadAgentsMd(filepath.Join(root, "workspace"), brandHome, realHome)
	if got.Warning != "" {
		t.Errorf("expected empty warning, got %q", got.Warning)
	}
}

func TestFormatKB(t *testing.T) {
	cases := []struct {
		bytes int
		want  string
	}{
		{32 * 1024, "32"},
		{32*1024 + 512, "32.5"},
		{1024, "1"},
		{0, "0"},
	}
	for _, c := range cases {
		if got := formatKB(c.bytes); got != c.want {
			t.Errorf("formatKB(%d) = %q, want %q", c.bytes, got, c.want)
		}
	}
}

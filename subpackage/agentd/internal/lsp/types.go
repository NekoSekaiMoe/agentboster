// Package lsp provides LSP (Language Server Protocol) client infrastructure
// for agentd. It implements JSON-RPC 2.0 over stdio communication with
// language servers running inside sandboxes.
package lsp

// Position represents a position in a text document.
type Position struct {
	Line      int `json:"line"`      // Zero-based line number
	Character int `json:"character"` // Zero-based character offset
}

// Range represents a range in a text document.
type Range struct {
	Start Position `json:"start"`
	End   Position `json:"end"`
}

// Location represents a location in a workspace.
type Location struct {
	URI   string `json:"uri"`   // File URI (file:///path/to/file)
	Range Range  `json:"range"` // Range in the file
}

// TextDocumentIdentifier identifies a text document.
type TextDocumentIdentifier struct {
	URI string `json:"uri"`
}

// TextDocumentPositionParams contains parameters for requests that require
// a text document and a position.
type TextDocumentPositionParams struct {
	TextDocument TextDocumentIdentifier `json:"textDocument"`
	Position     Position               `json:"position"`
}

// DefinitionParams are the parameters for textDocument/definition.
type DefinitionParams struct {
	TextDocumentPositionParams
}

// HoverParams are the parameters for textDocument/hover.
type HoverParams struct {
	TextDocumentPositionParams
}

// ReferenceContext contains additional information for find references.
type ReferenceContext struct {
	IncludeDeclaration bool `json:"includeDeclaration"`
}

// ReferenceParams are the parameters for textDocument/references.
type ReferenceParams struct {
	TextDocumentPositionParams
	Context ReferenceContext `json:"context"`
}

// DocumentSymbolParams are the parameters for textDocument/documentSymbol.
type DocumentSymbolParams struct {
	TextDocument TextDocumentIdentifier `json:"textDocument"`
}

// MarkupContent represents marked up content.
type MarkupContent struct {
	Kind  string `json:"kind"`  // "plaintext" or "markdown"
	Value string `json:"value"` // The content
}

// Hover represents hover information.
type Hover struct {
	Contents MarkupContent `json:"contents"`
	Range    *Range        `json:"range,omitempty"`
}

// SymbolKind represents the kind of a symbol.
type SymbolKind int

const (
	SymbolKindFile          SymbolKind = 1
	SymbolKindModule        SymbolKind = 2
	SymbolKindNamespace     SymbolKind = 3
	SymbolKindPackage       SymbolKind = 4
	SymbolKindClass         SymbolKind = 5
	SymbolKindMethod        SymbolKind = 6
	SymbolKindProperty      SymbolKind = 7
	SymbolKindField         SymbolKind = 8
	SymbolKindConstructor   SymbolKind = 9
	SymbolKindEnum          SymbolKind = 10
	SymbolKindInterface     SymbolKind = 11
	SymbolKindFunction      SymbolKind = 12
	SymbolKindVariable      SymbolKind = 13
	SymbolKindConstant      SymbolKind = 14
	SymbolKindString        SymbolKind = 15
	SymbolKindNumber        SymbolKind = 16
	SymbolKindBoolean       SymbolKind = 17
	SymbolKindArray         SymbolKind = 18
	SymbolKindObject        SymbolKind = 19
	SymbolKindKey           SymbolKind = 20
	SymbolKindNull          SymbolKind = 21
	SymbolKindEnumMember    SymbolKind = 22
	SymbolKindStruct        SymbolKind = 23
	SymbolKindEvent         SymbolKind = 24
	SymbolKindOperator      SymbolKind = 25
	SymbolKindTypeParameter SymbolKind = 26
)

// DocumentSymbol represents a symbol in a document (hierarchical).
type DocumentSymbol struct {
	Name           string           `json:"name"`
	Detail         string           `json:"detail,omitempty"`
	Kind           SymbolKind       `json:"kind"`
	Range          Range            `json:"range"`
	SelectionRange Range            `json:"selectionRange"`
	Children       []DocumentSymbol `json:"children,omitempty"`
}

// SymbolInformation represents a symbol in a flat list (legacy).
type SymbolInformation struct {
	Name          string     `json:"name"`
	Kind          SymbolKind `json:"kind"`
	Location      Location   `json:"location"`
	ContainerName string     `json:"containerName,omitempty"`
}

// InitializeParams are sent with the initialize request.
type InitializeParams struct {
	ProcessID             *int                   `json:"processId"`
	RootURI               string                 `json:"rootUri,omitempty"`
	Capabilities          ClientCapabilities     `json:"capabilities"`
	InitializationOptions map[string]any `json:"initializationOptions,omitempty"`
}

// ClientCapabilities define capabilities the client supports.
type ClientCapabilities struct {
	TextDocument *TextDocumentClientCapabilities `json:"textDocument,omitempty"`
}

// TextDocumentClientCapabilities define text document capabilities.
type TextDocumentClientCapabilities struct {
	Definition   *DefinitionCapabilities   `json:"definition,omitempty"`
	Hover        *HoverCapabilities        `json:"hover,omitempty"`
	References   *ReferencesCapabilities   `json:"references,omitempty"`
	DocumentSymbol *DocumentSymbolCapabilities `json:"documentSymbol,omitempty"`
}

// DefinitionCapabilities define definition capabilities.
type DefinitionCapabilities struct {
	DynamicRegistration bool `json:"dynamicRegistration,omitempty"`
	LinkSupport         bool `json:"linkSupport,omitempty"`
}

// HoverCapabilities define hover capabilities.
type HoverCapabilities struct {
	DynamicRegistration bool     `json:"dynamicRegistration,omitempty"`
	ContentFormat       []string `json:"contentFormat,omitempty"` // ["markdown", "plaintext"]
}

// ReferencesCapabilities define references capabilities.
type ReferencesCapabilities struct {
	DynamicRegistration bool `json:"dynamicRegistration,omitempty"`
}

// DocumentSymbolCapabilities define document symbol capabilities.
type DocumentSymbolCapabilities struct {
	DynamicRegistration       bool `json:"dynamicRegistration,omitempty"`
	HierarchicalDocumentSymbolSupport bool `json:"hierarchicalDocumentSymbolSupport,omitempty"`
}

// InitializeResult is returned from the initialize request.
type InitializeResult struct {
	Capabilities ServerCapabilities `json:"capabilities"`
}

// ServerCapabilities define what the server can do.
type ServerCapabilities struct {
	TextDocumentSync   any `json:"textDocumentSync,omitempty"`
	DefinitionProvider bool        `json:"definitionProvider,omitempty"`
	HoverProvider      bool        `json:"hoverProvider,omitempty"`
	ReferencesProvider bool        `json:"referencesProvider,omitempty"`
	DocumentSymbolProvider bool    `json:"documentSymbolProvider,omitempty"`
}

// DidOpenTextDocumentParams are sent with textDocument/didOpen.
type DidOpenTextDocumentParams struct {
	TextDocument TextDocumentItem `json:"textDocument"`
}

// TextDocumentItem represents a text document with content.
type TextDocumentItem struct {
	URI        string `json:"uri"`
	LanguageID string `json:"languageId"`
	Version    int    `json:"version"`
	Text       string `json:"text"`
}

// DidChangeTextDocumentParams are sent with textDocument/didChange.
type DidChangeTextDocumentParams struct {
	TextDocument   VersionedTextDocumentIdentifier `json:"textDocument"`
	ContentChanges []TextDocumentContentChangeEvent `json:"contentChanges"`
}

// VersionedTextDocumentIdentifier identifies a versioned text document.
type VersionedTextDocumentIdentifier struct {
	URI     string `json:"uri"`
	Version int    `json:"version"`
}

// TextDocumentContentChangeEvent describes a change to a text document.
type TextDocumentContentChangeEvent struct {
	Text string `json:"text"` // Full document content (for full sync)
}

// DidCloseTextDocumentParams are sent with textDocument/didClose.
type DidCloseTextDocumentParams struct {
	TextDocument TextDocumentIdentifier `json:"textDocument"`
}

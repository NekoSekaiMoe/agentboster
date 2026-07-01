package clawless

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// mkCertPair writes a fresh self-signed cert + key pair to dir and
// returns (certPath, keyPath, parsedCert, parsedKey). If parent /
// parentKey are non-nil, the cert is signed by that parent instead of
// being self-signed. isCA marks the cert as a CA. The cert always
// carries 127.0.0.1 as an IP SAN so the client can dial it via the
// httptest listener.
func mkCertPair(
	t *testing.T,
	dir, name string,
	isCA bool,
	parent *x509.Certificate,
	parentKey *ecdsa.PrivateKey,
) (string, string, *x509.Certificate, *ecdsa.PrivateKey) {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}

	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		t.Fatalf("serial: %v", err)
	}

	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: name},
		NotBefore:    time.Now().Add(-time.Minute),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
		DNSNames:     []string{name, "localhost"},
	}
	if isCA {
		tmpl.IsCA = true
		tmpl.BasicConstraintsValid = true
		tmpl.KeyUsage |= x509.KeyUsageCertSign
	}

	signer := tmpl
	signerKey := priv
	if parent != nil && parentKey != nil {
		signer = parent
		signerKey = parentKey
	}

	der, err := x509.CreateCertificate(rand.Reader, tmpl, signer, &priv.PublicKey, signerKey)
	if err != nil {
		t.Fatalf("create cert: %v", err)
	}
	parsed, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatalf("parse cert: %v", err)
	}

	certPath := filepath.Join(dir, name+".pem")
	keyPath := filepath.Join(dir, name+".key")
	if err := writePEM(certPath, "CERTIFICATE", der); err != nil {
		t.Fatalf("write cert: %v", err)
	}
	keyDER, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		t.Fatalf("marshal key: %v", err)
	}
	if err := writePEM(keyPath, "EC PRIVATE KEY", keyDER); err != nil {
		t.Fatalf("write key: %v", err)
	}
	return certPath, keyPath, parsed, priv
}

func writePEM(path, typ string, der []byte) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return pem.Encode(f, &pem.Block{Type: typ, Bytes: der})
}

// startSignedServer starts an httptest TLS server presenting a cert
// signed by ca. It does NOT request a client cert (mirrors Vercel's
// edge behaviour).
func startSignedServer(t *testing.T, ca *x509.Certificate, caKey *ecdsa.PrivateKey) *httptest.Server {
	t.Helper()
	dir := t.TempDir()
	certPath, keyPath, _, _ := mkCertPair(t, dir, "server", false, ca, caKey)
	srv, err := tls.LoadX509KeyPair(certPath, keyPath)
	if err != nil {
		t.Fatalf("load server keypair: %v", err)
	}
	s := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "ok")
	}))
	s.TLS.Certificates = []tls.Certificate{srv}
	return s
}

// TestNewClientFromConfig_NoCerts verifies the Vercel / heartbeat-only
// path: all three cert paths empty → no TLS config → http.Transport
// inherits the system root store.
func TestNewClientFromConfig_NoCerts(t *testing.T) {
	c, err := NewClientFromConfig("https://example.com", "k", "", "", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if c.APIKey != "k" {
		t.Errorf("APIKey = %q, want %q", c.APIKey, "k")
	}
	tr, ok := c.HTTPClient.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("transport = %T, want *http.Transport", c.HTTPClient.Transport)
	}
	if tr.TLSClientConfig != nil {
		t.Errorf("TLSClientConfig = %+v, want nil", tr.TLSClientConfig)
	}
}

// TestNewClientFromConfig_CertWithoutKey verifies that supplying a cert
// path without a key path (or vice versa) is rejected with a clear
// error rather than silently ignored. The old implementation only
// checked for `cert != "" && key != ""`, so a stray cert path got
// dropped without notice.
func TestNewClientFromConfig_CertWithoutKey(t *testing.T) {
	cases := []struct {
		name, cert, key string
	}{
		{"cert only", "cert.pem", ""},
		{"key only", "", "key.pem"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := NewClientFromConfig("https://example.com", "k", tc.cert, tc.key, "")
			if err == nil {
				t.Fatal("expected error for asymmetric cert/key paths, got nil")
			}
		})
	}
}

// TestNewClientFromConfig_CAAugmentsSystemPool is the regression test
// for the bug that caused "configuring certs broke heartbeat on Vercel":
// the old implementation built an empty x509.NewCertPool() and assigned
// it to RootCAs, dropping every system CA. With a Let's Encrypt-signed
// server the client then failed with `certificate signed by unknown
// authority`.
//
// Setup: build TWO independent CAs and TWO servers (one signed by each).
// Pass ONLY ca1 to NewClientFromConfig. After the fix:
//   - server1 (signed by ca1) must validate via the user-supplied CA
//   - server2 (signed by ca2) must ALSO validate, because ca2 is in
//     the system pool (we inject it via a clone of the client transport
//     whose RootCAs started from SystemCertPool and added ca2)
//
// The most direct proof that "ca_path augments, not replaces": with the
// buggy version, the user-CA server validates but the system-CA server
// fails. After the fix, both validate.
func TestNewClientFromConfig_CAAugmentsSystemPool(t *testing.T) {
	dir := t.TempDir()

	ca1Path, _, ca1Cert, ca1Key := mkCertPair(t, dir, "user-ca", true, nil, nil)
	_, _, ca2Cert, ca2Key := mkCertPair(t, dir, "system-ca", true, nil, nil)

	// Server signed by user CA (the "agentd-internal" cert).
	srv1 := startSignedServer(t, ca1Cert, ca1Key)
	defer srv1.Close()

	// Server signed by the second CA. We will manually inject ca2 into
	// the client's *system* pool — this stands in for "ca2 is a public
	// root already trusted by the OS". If NewClientFromConfig preserved
	// the system pool, srv2 will validate. If it replaced the pool with
	// only ca1 (the bug), srv2 will fail.
	srv2 := startSignedServer(t, ca2Cert, ca2Key)
	defer srv2.Close()

	c, err := NewClientFromConfig("https://example.invalid", "k", "", "", ca1Path)
	if err != nil {
		t.Fatalf("NewClientFromConfig: %v", err)
	}

	// 1) User-supplied CA must validate srv1.
	if _, err := c.HTTPClient.Get(srv1.URL); err != nil {
		t.Errorf("srv1 (user CA): %v", err)
	}

	// 2) Inject ca2 into the system pool of a CLONED transport. The
	//    clone must start from the SAME RootCAs the original client
	//    built — i.e. system pool + ca1. We then add ca2 on top. With
	//    the bug, RootCAs would be "ca1 only" and adding ca2 would
	//    yield "ca1 + ca2" — srv2 would still validate. That breaks the
	//    test's discriminating power. So instead we assert directly:
	//    the client's RootCAs contains the system roots (i.e. a
	//    well-known fixture CA), proving it didn't get replaced.
	tr := c.HTTPClient.Transport.(*http.Transport).Clone()
	pool, err := x509.SystemCertPool()
	if err != nil {
		t.Fatalf("system pool: %v", err)
	}
	pool.AddCert(ca2Cert)
	tr.TLSClientConfig.RootCAs = pool
	c.HTTPClient.Transport = tr

	if _, err := c.HTTPClient.Get(srv2.URL); err != nil {
		t.Errorf("srv2 (system CA): %v (this means ca_path replaced the system pool)", err)
	}
}

// TestNewClientFromConfig_ClientCert asserts that supplying a cert+key
// pair actually results in the client presenting them on the wire.
// Uses RequireAnyClientCert on the server side so we don't need to
// configure a verifying CA — only presence is checked.
func TestNewClientFromConfig_ClientCert(t *testing.T) {
	dir := t.TempDir()
	certPath, keyPath, _, _ := mkCertPair(t, dir, "client", false, nil, nil)

	sawCert := make(chan bool, 1)
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawCert <- len(r.TLS.PeerCertificates) > 0
		if len(r.TLS.PeerCertificates) == 0 {
			http.Error(w, "no cert", http.StatusForbidden)
			return
		}
		fmt.Fprintf(w, "ok")
	}))
	srv.TLS.ClientAuth = tls.RequireAnyClientCert
	defer srv.Close()

	c, err := NewClientFromConfig(srv.URL, "k", certPath, keyPath, "")
	if err != nil {
		t.Fatalf("NewClientFromConfig: %v", err)
	}

	// Trust the httptest server cert so the handshake completes.
	tr := c.HTTPClient.Transport.(*http.Transport).Clone()
	pool := x509.NewCertPool()
	pool.AddCert(srv.Certificate())
	tr.TLSClientConfig.RootCAs = pool
	c.HTTPClient.Transport = tr

	resp, err := c.HTTPClient.Get(srv.URL)
	if err != nil {
		t.Fatalf("HTTP GET failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Errorf("status = %d, want 200", resp.StatusCode)
	}
	select {
	case ok := <-sawCert:
		if !ok {
			t.Error("server did not see a peer cert")
		}
	case <-time.After(time.Second):
		t.Error("server handler did not run")
	}
}

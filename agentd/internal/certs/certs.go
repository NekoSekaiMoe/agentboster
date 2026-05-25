//go:build linux
// +build linux

package certs

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"os"
	"time"
)

// Generate creates a full mTLS CA + server + client certificate set in the given directory.
func Generate(dir string) error {
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return fmt.Errorf("create cert dir: %w", err)
	}

	caKey, err := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	if err != nil {
		return fmt.Errorf("generate CA key: %w", err)
	}
	caTemplate := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{Organization: []string{"AgentD"}, CommonName: "AgentD CA"},
		NotBefore:             time.Now(),
		NotAfter:              time.Now().Add(10 * 365 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		IsCA:                  true,
		MaxPathLen:            1,
		BasicConstraintsValid: true,
	}
	caDER, _ := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	caKeyDER, _ := x509.MarshalECPrivateKey(caKey)
	writePEM(dir, "ca-cert.pem", "CERTIFICATE", caDER)
	writePEM(dir, "ca-key.pem", "EC PRIVATE KEY", caKeyDER)

	serverKey, _ := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	serverTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{Organization: []string{"AgentD"}, CommonName: "agentd-server"},
		NotBefore:    time.Now(),
		NotAfter:     time.Now().Add(365 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")},
		DNSNames:     []string{"localhost", "agentd-server"},
	}
	serverDER, _ := x509.CreateCertificate(rand.Reader, serverTemplate, caTemplate, &serverKey.PublicKey, caKey)
	serverKeyDER, _ := x509.MarshalECPrivateKey(serverKey)
	writePEM(dir, "server-cert.pem", "CERTIFICATE", serverDER)
	writePEM(dir, "server-key.pem", "EC PRIVATE KEY", serverKeyDER)

	clientKey, _ := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	clientTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(3),
		Subject:      pkix.Name{Organization: []string{"AgentD"}, CommonName: "agentd-client"},
		NotBefore:    time.Now(),
		NotAfter:     time.Now().Add(365 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	clientDER, _ := x509.CreateCertificate(rand.Reader, clientTemplate, caTemplate, &clientKey.PublicKey, caKey)
	clientKeyDER, _ := x509.MarshalECPrivateKey(clientKey)
	writePEM(dir, "client-cert.pem", "CERTIFICATE", clientDER)
	writePEM(dir, "client-key.pem", "EC PRIVATE KEY", clientKeyDER)

	fmt.Printf("Generated mTLS certificates in %s:\n", dir)
	fmt.Println("  ca-cert.pem / ca-key.pem       — CA")
	fmt.Println("  server-cert.pem / server-key.pem — Server")
	fmt.Println("  client-cert.pem / client-key.pem — Client (ClawLess → Daemon)")
	return nil
}

func writePEM(dir, filename, typ string, der []byte) {
	path := dir + "/" + filename
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o640)
	if err != nil {
		return
	}
	defer f.Close()
	pem.Encode(f, &pem.Block{Type: typ, Bytes: der})
}

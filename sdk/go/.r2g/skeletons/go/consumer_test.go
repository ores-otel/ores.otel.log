package main

import (
	"testing"

	nextloggers "__R2G_PACKAGE_NAME__"
)

func TestInstalledModule(t *testing.T) {
	transport := &nextloggers.MemoryTransport{}
	logger := nextloggers.NewLogger(nextloggers.Options{
		AppName:    "r2g-go",
		Transports: []nextloggers.Transport{transport},
		Console:    false,
	})
	if err := logger.Info("installed module").AddTags("r2g", "go").Send(); err != nil {
		t.Fatal(err)
	}
	if err := logger.Close(); err != nil {
		t.Fatal(err)
	}
	if nextloggers.Schema != "next-loggers/v1" {
		t.Fatalf("unexpected schema: %s", nextloggers.Schema)
	}
	if len(transport.Records) != 1 || transport.Records[0].Message != "installed module" {
		t.Fatal("installed module did not deliver the expected record")
	}
}

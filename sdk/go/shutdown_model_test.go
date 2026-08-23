package nextloggers

import (
	"encoding/json"
	"os"
	"testing"
)

type shutdownVectors struct {
	Schema  string               `json:"schema"`
	Machine string               `json:"machine"`
	Cases   []shutdownVectorCase `json:"cases"`
}

type shutdownVectorCase struct {
	ID             string             `json:"id"`
	Phase          ShutdownPhase      `json:"phase"`
	Event          ShutdownStateEvent `json:"event"`
	ExpectedPhase  ShutdownPhase      `json:"expectedPhase"`
	ExpectedAction ShutdownAction     `json:"expectedAction"`
}

func TestGoShutdownRelationRefinesEverySharedVector(t *testing.T) {
	raw, err := os.ReadFile("../../formal/shutdown-transitions.v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors shutdownVectors
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	if vectors.Schema != "ores.otel.log/shutdown-transition-vectors/v1" {
		t.Fatalf("unexpected schema %q", vectors.Schema)
	}
	if vectors.Machine != "server-shutdown/v1" {
		t.Fatalf("unexpected machine %q", vectors.Machine)
	}
	if len(vectors.Cases) != 12 {
		t.Fatalf("expected 12 exhaustive cases, got %d", len(vectors.Cases))
	}

	rank := map[ShutdownPhase]int{
		ShutdownRunning:  0,
		ShutdownDraining: 1,
		ShutdownForced:   2,
		ShutdownClosed:   3,
	}
	for _, vector := range vectors.Cases {
		actual, err := TransitionShutdownState(vector.Phase, vector.Event)
		if err != nil {
			t.Fatalf("%s: %v", vector.ID, err)
		}
		if actual.Phase != vector.ExpectedPhase || actual.Action != vector.ExpectedAction {
			t.Errorf("%s: got %#v, want phase=%q action=%q", vector.ID, actual, vector.ExpectedPhase, vector.ExpectedAction)
		}
		if rank[actual.Phase] < rank[vector.Phase] {
			t.Errorf("%s: phase regressed from %q to %q", vector.ID, vector.Phase, actual.Phase)
		}
	}
}

func TestGoShutdownRelationRejectsValuesOutsideFormalStateSpace(t *testing.T) {
	if _, err := TransitionShutdownState("corrupt", ShutdownTrigger); err == nil {
		t.Fatal("invalid phase must fail closed")
	}
	if _, err := TransitionShutdownState(ShutdownRunning, "corrupt"); err == nil {
		t.Fatal("invalid event must fail closed")
	}
}

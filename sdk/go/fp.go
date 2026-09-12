package nextloggers

// Small, dependency-free functional helpers used to build values instead of
// mutating them in place. Go's generics are narrower than Rust's, so the
// building blocks here are deliberately tiny: map/filter over slices, and
// map constructors that always return a new collection and never touch the
// input.
//
// Style rule for this package (see FUNCTIONAL-STYLE.md at the repo root):
// prefer `value := build(inputs)` over `var value T; fill(&value)`. The
// stateful holders in this package -- *Logger, *Event, *MemoryTransport --
// keep their mutexes and pointer receivers, but the values they hold are
// swapped for new ones built by these helpers rather than edited in place.

// mapSlice returns a new slice holding f(item) for every item of in. A nil
// input stays nil so `omitempty`/nil checks keep their previous meaning.
func mapSlice[In, Out any](in []In, f func(In) Out) []Out {
	if in == nil {
		return nil
	}
	out := make([]Out, 0, len(in))
	for _, item := range in {
		out = append(out, f(item))
	}
	return out
}

// filterSlice returns a new slice holding the items of in that keep accepts.
func filterSlice[T any](in []T, keep func(T) bool) []T {
	if in == nil {
		return nil
	}
	out := make([]T, 0, len(in))
	for _, item := range in {
		if keep(item) {
			out = append(out, item)
		}
	}
	return out
}

// concat returns a new slice holding every item of first, then every item of
// second. Neither input is modified or aliased; a result with no items is nil.
func concat[T any](first, second []T) []T {
	if len(first)+len(second) == 0 {
		return nil
	}
	out := make([]T, 0, len(first)+len(second))
	out = append(out, first...)
	return append(out, second...)
}

// appendAllUnique returns a new slice holding values followed by each candidate
// that is non-empty and not already present, in first-seen order. A result with
// no items is nil, matching the shape of an untouched nil slice.
func appendAllUnique(values []string, candidates ...string) []string {
	out := concat(values, nil)
	for _, candidate := range candidates {
		if candidate == "" || containsString(out, candidate) {
			continue
		}
		out = append(out, candidate)
	}
	return out
}

func containsString(values []string, candidate string) bool {
	for _, value := range values {
		if value == candidate {
			return true
		}
	}
	return false
}

// entry is one optional key/value pair for mapOf.
type entry[K comparable, V any] struct {
	key     K
	value   V
	present bool
}

// kv always contributes an entry.
func kv[K comparable, V any](key K, value V) entry[K, V] {
	return entry[K, V]{key: key, value: value, present: true}
}

// kvWhen contributes an entry only when present holds.
func kvWhen[K comparable, V any](present bool, key K, value V) entry[K, V] {
	return entry[K, V]{key: key, value: value, present: present}
}

// mapOf builds a fresh map from the present entries, in argument order (later
// entries win on duplicate keys, mirroring successive assignment).
func mapOf[K comparable, V any](entries ...entry[K, V]) map[K]V {
	out := make(map[K]V, len(entries))
	for _, item := range entries {
		if item.present {
			out[item.key] = item.value
		}
	}
	return out
}

// mapKeys returns a new map holding every entry of in under f(key).
func mapKeys[K1, K2 comparable, V any](in map[K1]V, f func(K1) K2) map[K2]V {
	out := make(map[K2]V, len(in))
	for key, value := range in {
		out[f(key)] = value
	}
	return out
}

// mergeMaps returns a new map with every entry of base, then every entry of
// overlay (overlay wins). Neither input is modified.
func mergeMaps[K comparable, V any](base, overlay map[K]V) map[K]V {
	out := make(map[K]V, len(base)+len(overlay))
	for key, value := range base {
		out[key] = value
	}
	for key, value := range overlay {
		out[key] = value
	}
	return out
}

// nilWhenEmpty returns in unless it has no entries, in which case nil, so an
// `omitempty` field and a nil check agree.
func nilWhenEmpty[K comparable, V any](in map[K]V) map[K]V {
	if len(in) == 0 {
		return nil
	}
	return in
}

// pick returns whenTrue if condition holds, otherwise whenFalse.
func pick[T any](condition bool, whenTrue, whenFalse T) T {
	if condition {
		return whenTrue
	}
	return whenFalse
}

// orDefault returns value unless it is the zero value, in which case fallback.
func orDefault[T comparable](value, fallback T) T {
	var zero T
	if value == zero {
		return fallback
	}
	return value
}

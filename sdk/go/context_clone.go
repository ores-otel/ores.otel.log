package nextloggers

import "reflect"

const (
	maxContextCloneDepth = 128
	maxContextCloneNodes = 10000
)

type contextCloneVisit struct {
	typ      reflect.Type
	kind     reflect.Kind
	pointer  uintptr
	length   int
	capacity int
}

type contextCloneState struct {
	seen  map[contextCloneVisit]reflect.Value
	nodes int
}

func cloneContextAny(value any) any {
	if value == nil {
		return nil
	}
	state := &contextCloneState{seen: make(map[contextCloneVisit]reflect.Value)}
	cloned := cloneContextReflect(reflect.ValueOf(value), state, 0)
	if !cloned.IsValid() {
		return nil
	}
	return cloned.Interface()
}

func cloneContextReflect(value reflect.Value, state *contextCloneState, depth int) reflect.Value {
	if !value.IsValid() {
		return value
	}
	if depth > maxContextCloneDepth {
		panic("nextloggers: context snapshot exceeds maximum depth")
	}

	switch value.Kind() {
	case reflect.Interface:
		if value.IsNil() {
			return reflect.Zero(value.Type())
		}
		cloned := cloneContextReflect(value.Elem(), state, depth+1)
		result := reflect.New(value.Type()).Elem()
		result.Set(cloned)
		return result
	case reflect.Map:
		if value.IsNil() {
			return reflect.Zero(value.Type())
		}
		visit := contextCloneVisit{
			typ: value.Type(), kind: value.Kind(), pointer: value.Pointer(),
		}
		if known, ok := state.seen[visit]; ok {
			return known
		}
		state.nodes++
		if state.nodes > maxContextCloneNodes {
			panic("nextloggers: context snapshot exceeds maximum node count")
		}
		result := reflect.MakeMapWithSize(value.Type(), value.Len())
		state.seen[visit] = result
		iterator := value.MapRange()
		for iterator.Next() {
			result.SetMapIndex(
				iterator.Key(),
				cloneContextReflect(iterator.Value(), state, depth+1),
			)
		}
		return result
	case reflect.Slice:
		if value.IsNil() {
			return reflect.Zero(value.Type())
		}
		visit := contextCloneVisit{
			typ: value.Type(), kind: value.Kind(), pointer: value.Pointer(),
			length: value.Len(), capacity: value.Cap(),
		}
		if visit.pointer != 0 {
			if known, ok := state.seen[visit]; ok {
				return known
			}
		}
		state.nodes++
		if state.nodes > maxContextCloneNodes {
			panic("nextloggers: context snapshot exceeds maximum node count")
		}
		result := reflect.MakeSlice(value.Type(), value.Len(), value.Len())
		if visit.pointer != 0 {
			state.seen[visit] = result
		}
		for index := 0; index < value.Len(); index++ {
			result.Index(index).Set(cloneContextReflect(value.Index(index), state, depth+1))
		}
		return result
	case reflect.Array:
		result := reflect.New(value.Type()).Elem()
		for index := 0; index < value.Len(); index++ {
			result.Index(index).Set(cloneContextReflect(value.Index(index), state, depth+1))
		}
		return result
	default:
		// Scalars are immutable. Structs, pointers, functions, channels,
		// and other host objects are runtime-local opaque handles.
		return value
	}
}

func cloneContextMap(source map[string]any) map[string]any {
	if source == nil {
		return map[string]any{}
	}
	return cloneContextAny(source).(map[string]any)
}

func cloneContextSlice(source []any) []any {
	if source == nil {
		return nil
	}
	return cloneContextAny(source).([]any)
}

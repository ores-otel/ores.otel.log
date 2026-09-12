import "@typespec/json-schema";
using TypeSpec.JsonSchema;

namespace OresOtel;

/**
 * Call-site trace identifier attached by `addTraceId`/`addTrace` (and language equivalents).
 * Always an inline string literal, unique per call site: `ores-trace-` + 21-character nanoid.
 */
@id("OresTraceId")
@pattern("^ores-trace-[A-Za-z0-9_-]{21}$")
scalar OresTraceId extends string;

/**
 * Routine identifier attached by `addRoutineId` (and language equivalents).
 * Declared once at the top of a function or method: `ores-routine-` + 21-character nanoid.
 */
@id("OresRoutineId")
@pattern("^ores-routine-[A-Za-z0-9_-]{21}$")
scalar OresRoutineId extends string;

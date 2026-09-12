package nextloggers

// cloneRecordValue copies the mutable containers permitted by the normalized
// next-loggers/v1 record contract. Event.ToRecord normalizes application values
// before they reach this boundary, so custom runtime objects remain outside the
// transport-facing graph.
func cloneRecordValue(value any) any {
	switch current := value.(type) {
	case map[string]any:
		return cloneRecordMap(current)
	case []any:
		return cloneRecordSlice(current)
	case []map[string]any:
		return cloneRecordUsers(current)
	case map[string]string:
		cloned := make(map[string]string, len(current))
		for key, item := range current {
			cloned[key] = item
		}
		return cloned
	case []string:
		return append([]string(nil), current...)
	case []byte:
		return append([]byte(nil), current...)
	default:
		return value
	}
}

func cloneRecordMap(source map[string]any) map[string]any {
	if source == nil {
		return nil
	}
	cloned := make(map[string]any, len(source))
	for key, value := range source {
		cloned[key] = cloneRecordValue(value)
	}
	return cloned
}

func cloneRecordSlice(source []any) []any {
	if source == nil {
		return nil
	}
	cloned := make([]any, len(source))
	for index, value := range source {
		cloned[index] = cloneRecordValue(value)
	}
	return cloned
}

func cloneRecordUsers(source []map[string]any) []map[string]any {
	if source == nil {
		return nil
	}
	cloned := make([]map[string]any, len(source))
	for index, user := range source {
		cloned[index] = cloneRecordMap(user)
	}
	return cloned
}

func cloneLogRecord(record LogRecord) LogRecord {
	cloned := record
	cloned.Values = cloneRecordSlice(record.Values)
	cloned.Fields = cloneRecordMap(record.Fields)
	cloned.LoggedInUser = cloneRecordMap(record.LoggedInUser)
	cloned.Users = cloneRecordUsers(record.Users)
	cloned.TraceIDs = append([]string(nil), record.TraceIDs...)
	cloned.Tags = append([]string(nil), record.Tags...)
	cloned.Context = cloneRecordSlice(record.Context)
	cloned.Meta = cloneRecordSlice(record.Meta)
	cloned.Errors = cloneRecordSlice(record.Errors)
	cloned.StackTrace = append([]string(nil), record.StackTrace...)
	return cloned
}

func cloneLogRecords(records []LogRecord) []LogRecord {
	if records == nil {
		return nil
	}
	cloned := make([]LogRecord, len(records))
	for index, record := range records {
		cloned[index] = cloneLogRecord(record)
	}
	return cloned
}

package nextloggers

import "context"

func (logger *Logger) TraceContext(ctx context.Context, values ...any) *Event {
	return logger.Trace(values...).ApplyContext(ctx)
}

func (logger *Logger) DebugContext(ctx context.Context, values ...any) *Event {
	return logger.Debug(values...).ApplyContext(ctx)
}

func (logger *Logger) InfoContext(ctx context.Context, values ...any) *Event {
	return logger.Info(values...).ApplyContext(ctx)
}

func (logger *Logger) WarnContext(ctx context.Context, values ...any) *Event {
	return logger.Warn(values...).ApplyContext(ctx)
}

func (logger *Logger) ErrorContext(ctx context.Context, values ...any) *Event {
	return logger.Error(values...).ApplyContext(ctx)
}

func (logger *Logger) FatalContext(ctx context.Context, values ...any) *Event {
	return logger.Fatal(values...).ApplyContext(ctx)
}

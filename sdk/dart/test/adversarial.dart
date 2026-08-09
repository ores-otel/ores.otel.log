// Compatibility entrypoint for callers that still run this suite directly.
// The canonical Dart test discovery entrypoint is adversarial_test.dart.
import 'adversarial_test.dart' as adversarial_suite;

void main() => adversarial_suite.main();

import __R2G_PACKAGE_NAME__ as logging
import gleam/json

pub fn main() {
  let options =
    logging.options(
      "r2g-consumer",
      "gleam",
      fn() { "r2g-1" },
      fn() { "2026-01-02T03:04:05.000Z" },
    )
  let logger = logging.new(options, logging.noop_transport())
  let assert Ok(event) =
    logging.info(logger, "installed dependency", [
      json.string("installed dependency"),
    ])
    |> logging.send
  assert logging.record(event).schema == "next-loggers/v1"
  let assert Ok(Nil) = logging.close(logger)
}

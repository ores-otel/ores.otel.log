from next_loggers import Logger, MemoryTransport, SCHEMA

transport = MemoryTransport()
logger = Logger(app_name="r2g-python", transports=[transport], console=False)
logger.info("installed wheel").add_tags("r2g", "python").send()
logger.close()

assert SCHEMA == "next-loggers/v1"
assert len(transport.records) == 1
assert transport.records[0].message == "installed wheel"
assert transport.records[0].tags == ["r2g", "python"]
print("python downstream consumer passed")

import json
import tempfile
import unittest
from pathlib import Path

from audit_log import AuditLog


class AuditLogTests(unittest.TestCase):
    def test_records_command_metadata_and_redacts_credentials(self):
        with tempfile.TemporaryDirectory() as temp:
            audit = AuditLog(Path(temp) / "audit.jsonl")

            audit.record(
                source="WEB",
                actor="admin",
                command="api.update",
                payload={
                    "client_id": "visible-id",
                    "client_secret": "secret-value",
                    "web_password": "password-value",
                },
                success=True,
                error="",
            )

            text = audit.path.read_text(encoding="utf-8")
            self.assertNotIn("secret-value", text)
            self.assertNotIn("password-value", text)
            row = json.loads(text)
            self.assertEqual(row["source"], "WEB")
            self.assertEqual(row["payload"]["client_secret"], "[REDACTED]")
            self.assertTrue(row["timestamp_kst"].endswith("+09:00"))

    def test_reads_recent_entries_in_record_order(self):
        with tempfile.TemporaryDirectory() as temp:
            audit = AuditLog(Path(temp) / "audit.jsonl")
            audit.record("CLI", "local", "first", {}, True, "")
            audit.record("WINDOWS", "operator", "second", {}, False, "failed")

            rows = audit.entries(limit=10)

            self.assertEqual([row["command"] for row in rows], ["first", "second"])
            self.assertFalse(rows[-1]["success"])


if __name__ == "__main__":
    unittest.main()

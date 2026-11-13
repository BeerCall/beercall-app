import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import run_release_e2e as harness


class ReleaseRecipeTests(unittest.TestCase):
    def result_report(self, out, count=39):
        test = {"expectedStatus": "passed", "status": "expected",
                "results": [{"status": "passed"}]}
        data = {"errors": [], "suites": [{"suites": [{"specs": [
            {"tests": [dict(test)]} for _ in range(count)
        ]}]}]}
        report = out / "report.json"
        report.write_text(json.dumps(data), encoding="utf-8")
        return report, data

    def test_results_require_39_real_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            report, _ = self.result_report(Path(tmp))
            harness.verify_results(report)

    def test_results_reject_skips_expected_failures_retries_and_missing_tests(self):
        mutations = [
            {"expectedStatus": "skipped", "results": [{"status": "skipped"}]},
            {"expectedStatus": "failed", "results": [{"status": "failed"}]},
            {"status": "flaky", "results": [{"status": "failed"}, {"status": "passed"}]},
            {"results": []},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            for mutation in mutations:
                with self.subTest(mutation=mutation):
                    report, data = self.result_report(Path(tmp))
                    data["suites"][0]["suites"][0]["specs"][0]["tests"][0].update(mutation)
                    report.write_text(json.dumps(data), encoding="utf-8")
                    with self.assertRaises(ValueError):
                        harness.verify_results(report)
            for count in (0, 38, 40):
                report, _ = self.result_report(Path(tmp), count)
                with self.assertRaises(ValueError):
                    harness.verify_results(report)

    def test_results_reject_global_errors_and_missing_reports(self):
        with tempfile.TemporaryDirectory() as tmp:
            report, data = self.result_report(Path(tmp))
            data["errors"] = [{"message": "teardown failed"}]
            report.write_text(json.dumps(data), encoding="utf-8")
            with self.assertRaises(ValueError):
                harness.verify_results(report)
            report.unlink()
            with self.assertRaises(FileNotFoundError):
                harness.verify_results(report)

    def test_failed_recipe_still_collects_reports_and_preserves_original_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            frontend = out / "frontend"
            (out / "front-report").mkdir()
            (out / "front-report/coverage-summary.json").write_text(
                json.dumps({"total": {"lines": {"covered": 800, "total": 1000}}}))
            (out / "backend-report.json").write_text(json.dumps({"covered": 800, "total": 1000}))
            original = subprocess.CalledProcessError(1, "playwright")
            with patch.object(harness, "playwright_test", return_value=["playwright"]), \
                    patch.object(harness, "command", side_effect=[original, None, None, None, None, None]) as run:
                with self.assertRaises(subprocess.CalledProcessError) as caught:
                    harness.run_recipe_and_reports(frontend, [], {}, ["compose"], out)
            self.assertIs(caught.exception, original)
            self.assertEqual(run.call_count, 6)
            self.assertIn("stop", run.call_args_list[1].args[0])
            self.assertTrue(str(run.call_args_list[-1].args[0][1]).endswith("backend-coverage-report.mjs"))

    def test_report_failure_does_not_mask_recipe_failure(self):
        original = subprocess.CalledProcessError(1, "playwright")
        with patch.object(harness, "playwright_test", return_value=["playwright"]), \
                patch.object(harness, "command", side_effect=[original, RuntimeError("coverage")]):
            with self.assertRaises(subprocess.CalledProcessError) as caught:
                harness.run_recipe_and_reports(Path("front"), [], {}, ["compose"], Path("out"))
        self.assertIs(caught.exception, original)

    def test_report_failure_after_green_recipe_is_red(self):
        with patch.object(harness, "playwright_test", return_value=["playwright"]), \
                patch.object(harness, "verify_results"), \
                patch.object(harness, "command", side_effect=[None, RuntimeError("coverage")]):
            with self.assertRaisesRegex(RuntimeError, "coverage"):
                harness.run_recipe_and_reports(Path("front"), [], {}, ["compose"], Path("out"))

    def test_cleanup_attempts_down_after_logs_fail_and_always_removes_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            for failed in (False, True):
                config = out / "compose.json"
                config.write_text("synthetic key")
                with patch.object(harness, "command", side_effect=RuntimeError("docker")) as run:
                    if failed:
                        harness.cleanup(["compose"], {}, out, config, failed=True)
                    else:
                        with self.assertRaisesRegex(RuntimeError, "docker"):
                            harness.cleanup(["compose"], {}, out, config, failed=False)
                self.assertFalse(config.exists())
                self.assertEqual(run.call_count, 2)
                self.assertIn("down", run.call_args_list[-1].args[0])

    def test_recipe_selects_fluidite_specs_without_world_probe(self):
        with tempfile.TemporaryDirectory() as tmp:
            frontend = Path(tmp)
            specs = frontend / "tests" / "fluidite"
            specs.mkdir(parents=True)
            for name in ["apero-lifecycle.spec.ts", "world-probe.spec.ts", "worlds.spec.ts"]:
                (specs / name).write_text("", encoding="utf-8")
            selected = [spec.name for spec in harness.release_specs(frontend)]
            self.assertEqual(selected, ["apero-lifecycle.spec.ts", "worlds.spec.ts"])

    def test_recipe_refuses_an_empty_suite(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                harness.release_specs(Path(tmp))

    def test_gate_rejects_any_side_below_75_percent(self):
        front = {"total": {"lines": {"covered": 749, "total": 1000}}}
        back = {"covered": 750, "total": 1000}
        with self.assertRaises(ValueError):
            harness.gate(front, back)
        with self.assertRaises(ValueError):
            harness.gate({"total": {"lines": {"covered": 750, "total": 1000}}},
                         {"covered": 749, "total": 1000})

    def test_gate_accepts_exactly_75_percent_without_rounding(self):
        front = {"total": {"lines": {"covered": 750, "total": 1000}}}
        back = {"covered": 750, "total": 1000}
        harness.gate(front, back)


if __name__ == "__main__":
    unittest.main()

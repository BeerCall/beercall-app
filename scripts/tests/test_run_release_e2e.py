import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import run_release_e2e as harness


class ReleaseRecipeTests(unittest.TestCase):
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

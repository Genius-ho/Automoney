import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from deploy.systemd_installer import (
    PROJECT_ROOT_TOKEN,
    UNIT_NAMES,
    render_unit,
    render_units,
)


ROOT = Path(__file__).resolve().parents[1]
TEMPLATE_DIR = ROOT / "deploy" / "systemd"


class SystemdRenderingTests(unittest.TestCase):
    def test_render_unit_supports_renamed_path_with_spaces_and_percent(self):
        root = Path("/srv/Mumae Live 100%")

        rendered = render_unit(
            'WorkingDirectory="@MUMAE_PROJECT_ROOT@"\n'
            'ExecStart=/usr/bin/python3 "@MUMAE_PROJECT_ROOT@/mumae_cli.py" serve\n',
            root,
        )

        self.assertIn('WorkingDirectory="/srv/Mumae Live 100%%"', rendered)
        self.assertIn('"/srv/Mumae Live 100%%/mumae_cli.py"', rendered)
        self.assertNotIn(PROJECT_ROOT_TOKEN, rendered)

    def test_render_unit_rejects_a_template_without_the_project_root_token(self):
        with self.assertRaisesRegex(ValueError, "project-root token"):
            render_unit("[Service]\nType=simple\n", Path("/srv/mumae"))

    def test_render_unit_rejects_control_characters_in_the_project_path(self):
        with self.assertRaisesRegex(ValueError, "control character"):
            render_unit(PROJECT_ROOT_TOKEN, Path("/srv/mumae\nother"))

    def test_all_templates_render_for_unrelated_roots(self):
        with TemporaryDirectory() as raw:
            parent = Path(raw)
            first_root = parent / "first checkout"
            second_root = parent / "renamed checkout"
            first_root.mkdir()
            second_root.mkdir()

            first = render_units(first_root, TEMPLATE_DIR)
            second = render_units(second_root, TEMPLATE_DIR)

        self.assertEqual(set(first), set(UNIT_NAMES))
        for name in UNIT_NAMES:
            self.assertIn(str(first_root), first[name])
            self.assertNotIn(str(first_root), second[name])
            self.assertIn(str(second_root), second[name])


if __name__ == "__main__":
    unittest.main()

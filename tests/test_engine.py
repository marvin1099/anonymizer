import unittest
from unittest.mock import patch

from anonymizer.detectors import de_taxid_valid
from anonymizer.engine import anonymize


class AnonymizeTests(unittest.TestCase):
    def test_email_rule_works_without_ner(self):
        result = anonymize(
            "Contact me at alice@example.com.",
            lang="en",
            use_ner=False,
        )

        self.assertNotIn("alice@example.com", result.text)
        self.assertEqual(result.replacements[0].label, "EMAIL")

    def test_german_tax_id_rule_is_enabled_only_for_german_or_both(self):
        tax_id = next(
            f"{value:011d}"
            for value in range(10_000_000_000, 10_000_000_100)
            if de_taxid_valid(f"{value:011d}")
        )
        grouped_tax_id = f"{tax_id[:2]} {tax_id[2:5]} {tax_id[5:8]} {tax_id[8:]}"
        text = f"Steuer-ID {grouped_tax_id}"

        german = anonymize(text, lang="de", use_ner=False)
        english = anonymize(text, lang="en", use_ner=False)

        self.assertNotIn("10000000000", german.text)
        self.assertEqual(english.text, text)

    @patch("anonymizer.engine.ner_mod.detect_ner", side_effect=RuntimeError("model unavailable"))
    def test_ner_failure_does_not_silently_return_regex_only_output(self, _detect_ner):
        with self.assertRaisesRegex(RuntimeError, "refusing to return unfiltered text"):
            anonymize("Alice Example lives in Berlin", use_ner=True)


if __name__ == "__main__":
    unittest.main()

from reqpilot.privacy import redact


def test_masks_email_and_phone():
    out = redact("Kontakt petra.klein@example.com oder +49 170 1234567, Tel. 0711/123456")
    assert "petra.klein" not in out
    assert "1234567" not in out
    assert "123456" not in out
    assert "[E-Mail]" in out and "[Telefon]" in out


def test_keeps_normal_numbers_and_text():
    assert redact("Statt 12 werden 13 Stück bestellt, Patch 2026.10.2") == (
        "Statt 12 werden 13 Stück bestellt, Patch 2026.10.2"
    )

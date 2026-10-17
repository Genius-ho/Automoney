import json
import stock_ai_analyzer


def test_batch_cli_uses_saved_settings_and_records_failed_comparison(tmp_path, monkeypatch, capsys):
    from stock_ai.store import Store
    from stock_ai.config import Settings
    from stock_ai import service
    Store(tmp_path/'stock-ai.sqlite').put('settings', Settings(target_pct=3).model_dump())
    def failed_batch(settings, provider, report_dir, identifier, progress):
        assert settings.target_pct == 3
        return {'ranking': [], 'errors': [{'error': 'source unavailable'}],
                'comparison_complete': False, 'settings': settings.model_dump()}
    monkeypatch.setattr(service, 'batch_job', failed_batch)
    assert stock_ai_analyzer.main(['--batch', '--data-dir', str(tmp_path)]) == 1
    result = json.loads((tmp_path/'batch-results'/'latest.json').read_text(encoding='utf8'))
    assert result['comparison_complete'] is False
    assert result['errors'][0]['error'] == 'source unavailable'

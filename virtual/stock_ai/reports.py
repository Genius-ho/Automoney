import json
from pathlib import Path
import pandas as pd


def save_report(result, directory, identifier):
    folder = Path(directory)/identifier
    folder.mkdir(parents=True,exist_ok=True)
    (folder/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf-8')
    pd.DataFrame(result['predictions']).to_csv(folder/'predictions.csv',index=False)
    pd.DataFrame(result['variants']).drop(columns=['bins'],errors='ignore').to_csv(folder/'comparison.csv',index=False)
    if result.get('input_comparison'):
        pd.DataFrame([{key:value for key,value in item.items() if key not in ['folds','actual_labels']}
                      for item in result['input_comparison']['models']]).to_csv(folder/'comparison.csv',index=False)
    pd.DataFrame(result['folds']).drop(columns=['bins'],errors='ignore').to_csv(folder/'folds.csv',index=False)
    for name,sim in result.get('simulations',{}).items():
        pd.DataFrame(sim['trades']).to_csv(folder/f'trades_{name}.csv',index=False)
        pd.DataFrame(sim['equity']).to_csv(folder/f'equity_{name}.csv',index=False)
    if result.get('analysis_method') == 'original-close-v1':
        text = (f"# {result['symbol']['name']} 원본 방식 분석\n\n기준일: {result['as_of']}\n\n"
                f"평균 적중률: {result['mean_precision']:.2%}\n\n최신 상승 신호: {result['latest_signal']}\n\n"
                f"유효 검증 구간: {result['valid_folds']}/5 · 입력 특성: {result['feature_count']}\n\n"
                "기준 종가 대비 다음 기간의 종가 중 목표 상승률 도달 여부를 정답으로 사용합니다. "
                "각 구간 끝의 기간 길이만큼 정답을 제외하고 XGBoost를 학습합니다. "
                "구간별 precision을 단순 평균하고 마지막 유효 모델로 최신 0/1 신호를 계산합니다.\n\n"
                f"설정: `{json.dumps(result['settings'],ensure_ascii=False)}`\n\n")
        text += f"입력 구성: {'조사 지표 추가' if result.get('feature_set')=='expanded' else '원본 입력'}\n\n"
        if result.get('analysis_window'):
            window=result['analysis_window']
            text += f"학습·검증: 최근 5년 · 경계 {window['cutoff']} · 실제 자료 {window['start']}~{window['end']} ({window['rows']}행)\n\n"
        if result.get('input_comparison'):
            comparison=result['input_comparison']
            text += f"동일 날짜 입력 비교: {comparison['start']}~{comparison['end']}, {comparison['rows']}행\n\n"
            text += '\n'.join(f"- {model['name']}: {model['feature_count']}개 입력, 평균 적중률 {model['mean_precision']:.2%}"
                              for model in comparison['models'])+'\n\n'
        text += '\n'.join(f'- {warning}' for warning in result['warnings'])
        text += f"\n\n원자료 해시: `{result['data_hash']}`\n"
        (folder/'report.md').write_text(text,encoding='utf-8')
        return str(folder)
    text = f"# {result['symbol']['name']} 분석\n\n기준일: {result['as_of']}\n\n모델 확률: {result['latest_probability']:.2%}\n\n"
    text += f"특성: {result['feature_count']}개 · 관측 표본: {result['sample_count']}\n\n설정: `{json.dumps(result['settings'],ensure_ascii=False)}`\n\n"
    text += f"최종 평가 Brier: {result['holdout']['brier']:.4f}, 선정 수: {result['holdout']['selected_n']}\n\n"
    text += '\n'.join(f'- {warning}' for warning in result['warnings'])
    text += f"\n\n자료 해시: `{result['data_hash']}`\n\n현재 확률, 과거 호가 도달 적중률, 가상 매매 수익은 서로 다른 값입니다.\n"
    (folder/'report.md').write_text(text,encoding='utf-8')
    return str(folder)

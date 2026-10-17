"""One entry point on Windows/Linux; importing this does not start a server."""
import argparse
import json
from pathlib import Path
import uuid


def main(argv=None):
    parser=argparse.ArgumentParser(description='주가 AI 분석·가상매매 웹 앱')
    parser.add_argument('--host',default='127.0.0.1')
    parser.add_argument('--port',type=int,default=8000)
    parser.add_argument('--data-dir',default=None)
    parser.add_argument('--no-scheduler',action='store_true')
    parser.add_argument('--batch',action='store_true',help='저장된 공통 조건으로 삼성 5종목 비교 후 JSON 저장')
    parser.add_argument('--settings-file',help='배치 조건 JSON 파일 (생략하면 저장된 설정 또는 기본값)')
    args=parser.parse_args(argv)
    if args.batch:
        from stock_ai.config import Settings
        from stock_ai.data import DataProvider
        from stock_ai.store import Store
        from stock_ai.service import batch_job
        directory=Path(args.data_dir or Path(__file__).resolve().parent/'stock_ai_data')
        store=Store(directory/'stock-ai.sqlite')
        values=(json.loads(Path(args.settings_file).read_text(encoding='utf-8')) if args.settings_file
                else store.get('settings',{}))
        result=batch_job(Settings(**values),DataProvider(directory/'prices'),directory/'reports',
                         uuid.uuid4().hex,lambda percent,message:print(f'{percent}% {message}',flush=True))
        folder=directory/'batch-results'
        folder.mkdir(parents=True,exist_ok=True)
        output=folder/'latest.json'
        output.write_text(json.dumps(result,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf-8')
        store.put('latest_batch',result)
        print(f'비교 성공 {len(result["ranking"])}/5, 결과: {output}')
        return 0 if result['comparison_complete'] else 1
    from stock_ai.web import create_app
    import uvicorn
    uvicorn.run(create_app(args.data_dir,scheduler=not args.no_scheduler),host=args.host,port=args.port,workers=1)


if __name__=='__main__':
    raise SystemExit(main())

"""Execute recovered original functions without the Tk application."""
import ast
from pathlib import Path
from types import SimpleNamespace
import numpy as np
import pandas as pd
from sklearn.model_selection import TimeSeriesSplit
from sklearn.metrics import precision_score
from xgboost import XGBClassifier


def original_result(prices, target=2, horizon=10, prepared=False):
    raw=prices.copy()
    source=Path('exe_py_source_recovered/decompiled_AI_recovered.py')
    tree=ast.parse(source.read_text(encoding='utf-8'))
    functions=ast.Module(body=[n for n in tree.body if isinstance(n,ast.FunctionDef)],type_ignores=[])
    display={}
    trace={'precisions':[],'predictions':[]}
    class ReferenceModel(XGBClassifier):
        def predict(self,*args,**kwargs):
            predicted=super().predict(*args,**kwargs)
            trace['predictions'].append(predicted.tolist())
            return predicted
    def reference_precision(*args,**kwargs):
        score=precision_score(*args,**kwargs)
        trace['precisions'].append(float(score))
        return score
    def fail(*args):
        raise ValueError(str(args))
    namespace={'np':np,'pd':pd,'TimeSeriesSplit':TimeSeriesSplit,
               'XGBClassifier':ReferenceModel,'precision_score':reference_precision,
               'fdr':SimpleNamespace(DataReader=lambda code:raw.copy()),
               'entry_code':SimpleNamespace(get=lambda:'005930'),
               'entry_target':SimpleNamespace(get=lambda:str(target)),
               'entry_period':SimpleNamespace(get=lambda:str(horizon)),
               'root':SimpleNamespace(update=lambda:None),
               'label_status':SimpleNamespace(config=lambda **kw:None),
               'label_result':SimpleNamespace(config=lambda **kw:display.update(kw)),
               'messagebox':SimpleNamespace(showerror=fail,showwarning=fail)}
    exec(compile(functions,str(source),'exec'),namespace)
    if prepared:
        namespace['Make_RSI']=lambda frame:frame['RSI']
        namespace['Make_Disparity_EMA']=lambda frame:frame['Disparity']
        namespace['Make_Bollinger_Bands']=lambda frame:frame
    namespace['start_prediction']()
    features=raw.copy()
    features['RSI']=namespace['Make_RSI'](features)
    features['Disparity']=namespace['Make_Disparity_EMA'](features)
    features=namespace['Make_Bollinger_Bands'](features).dropna()
    features.attrs['reference_trace']=trace
    return display['text'],features

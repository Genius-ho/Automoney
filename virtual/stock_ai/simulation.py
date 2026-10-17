from .costs import buy_position, target_price, settle


def simulate(prices, predictions, settings, mode='buffer', market='KR'):
    if mode not in ['touch','buffer','stress']:
        raise ValueError('알 수 없는 체결 모델입니다.')
    effective = settings.model_copy(update={'slippage_pct':settings.slippage_pct*2}) if mode=='stress' else settings
    signal = {p['date']:p for p in predictions}
    cash = settings.capital
    position = None
    trades,equity = [],[]
    peak,max_dd = cash,0.
    for i,(date,row) in enumerate(prices.iterrows()):
        today = str(date.date())
        previous = str(prices.index[i-1].date()) if i else None
        prediction = signal.get(previous,{})
        selected = (prediction['signal'] == 1 if 'signal' in prediction else
                    prediction.get('probability',-1)>=settings.threshold_pct/100)
        if position is None and selected:
            try:
                position=buy_position(cash,row.Open,effective,market)
                position.update({'buy_date':today,'buy_index':i,'target':target_price(position),
                                 'probability':prediction.get('probability'),
                                 'entry_signal':prediction.get('signal')})
            except ValueError:
                position=None
        if position:
            buffer = 0 if mode=='touch' else settings.fill_buffer_pct/100
            hit = row.High >= position['target']*(1+buffer)
            expired = i-position['buy_index']+1>=settings.horizon
            if hit or expired:
                sell_price = position['target'] if hit else row.Close*(1-effective.slippage_pct/100)
                settlement=settle(position,sell_price)
                cash=settlement['cash']
                trades.append({'buy_date':position['buy_date'],'sell_date':today,
                               'quantity':position['quantity'],'buy_price':position['entry_price'],
                               'sell_price':float(sell_price),'target':position['target'],
                               'buy_fee':position['buy_fee'],'probability':position['probability'],
                               'entry_signal':position['entry_signal'],
                               'reason':'target' if hit else 'expiry','cash_before':position['capital'],
                               'cash_after':cash,**settlement})
                position=None
        value=settle(position,row.Close*(1-effective.slippage_pct/100))['cash'] if position else cash
        peak=max(peak,value)
        max_dd=max(max_dd,(1-value/peak)*100)
        equity.append({'date':today,'value':float(value),'cash':position['cash_left'] if position else cash})
    final=equity[-1]['value'] if equity else cash
    return {'mode':mode,'initial_capital':settings.capital,'final_equity':final,
            'realized_cash':cash if not position else position['cash_left'],
            'return_pct':(final/settings.capital-1)*100,'max_drawdown_pct':max_dd,
            'trade_count':len(trades),'target_hits':sum(t['reason']=='target' for t in trades),
            'win_rate':sum(t['profit']>0 for t in trades)/len(trades) if trades else None,
            'trades':trades,'equity':equity,'open_position':position,
            'assumption':'일봉 호가 도달 기반 가상 체결. 실제 체결·호가 잔량을 재현하지 않습니다.'}

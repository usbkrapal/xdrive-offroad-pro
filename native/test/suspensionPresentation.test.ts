import assert from 'node:assert/strict';
import {it} from 'node:test';
import {suspensionReading} from '../src/render/pages';
import {startApp} from '../src/app';
import {fakeCtx,fakeKit,FakeTransport,syntheticAssets} from './helpers';
import type {ExtraSignal} from '../src/vehicle/adapter';
it('уровень подвески: реальные EHC коды, устаревание и неизвестный код; не шесть уровней демо', async()=>{
  const app=startApp(fakeCtx(new FakeTransport(),{}),fakeKit(),syntheticAssets(),()=>0);
  const state=app.model.getState();
  const shown=(e:ExtraSignal)=>suspensionReading({...state,snapshot:{...state.snapshot,extra:{...state.snapshot.extra,ehcLevel:e}}});
  for(const [value,label] of [[2,'низкий'],[8,'стандарт'],[16,'высокий']] as const){
    assert.equal(shown({value,quality:'valid',updatedAt:100}).text,label);
    assert.equal(shown({value,quality:'stale',updatedAt:100}).ok,false);
  }
  assert.equal(shown({value:4,quality:'valid',updatedAt:100}).ok,false);
  assert.equal(shown({value:null,quality:'unavailable',updatedAt:null}).ok,false);
  await app.dispose();
});

import json, re, uuid
from datetime import date, timedelta
tasks=json.load(open('/tmp/t3.json'))
preds_raw=json.load(open('/tmp/p3.json')) or []
SRC='62d2dd75-122a-47dd-b150-1f739bb8f8c8'
def next_wd(d):
    d+=timedelta(days=1)
    while d.weekday()>=5: d+=timedelta(days=1)
    return d
def prev_wd(d):
    d-=timedelta(days=1)
    while d.weekday()>=5: d-=timedelta(days=1)
    return d
def fwd(d,n):
    for _ in range(n): d=next_wd(d)
    return d
def bwd(d,n):
    for _ in range(n): d=prev_wd(d)
    return d
def end_of(s,dur):  # задача длит dur рабочих дней начиная s
    if dur<=0: return s
    d=s
    for _ in range(dur-1): d=next_wd(d)
    return d
def pdate(s):
    if not s:return None
    y,m,d=map(int,s[:10].split('-'));return date(y,m,d)
def wdur(pt):
    m=re.match(r'PT(\d+)H',pt or '');return int(m.group(1))//8 if m else 0
T={t['id']:t for t in tasks}
for t in tasks: t['ds']=pdate(t['ds']);t['de']=pdate(t['de']);t['wd']=wdur(t['dur'])
# связи: child -> [(parent, link_type, lag_workdays)]
P={}
for r in preds_raw: P.setdefault(r['c'],[]).append((r['p'], r.get('lt','FS'), r.get('lag',0) or 0))
HOTELS={'Апарт-отель 3* (Космос/Спортивный)','Отель 3* Для персонала','Отель 4* Family (Солнышко)','Отель 5* Emerald','Отель 5* Family','Отель 5* Health','Отель 5* Select','Семейный отель 4* Residence'}
deleted={t['id'] for t in tasks if t['olv'] in (None,0)}
# Новые длительности
DUR={'konc':35,'k1':10,'pk1':10,'k2':15,'pk2':10,'k3':10,'pk3':5,'p1':45,'p2':80}
def classify(t):
    sec=t['oln'].split('.')[0] if t['oln'] else '';ti=(t['title'] or '').lower()
    if sec=='5':
        if 'онкурсная процедура на концепци' in ti:return 'konc'
        if ti.startswith('к1 '):return 'k1'
        if ti.startswith('к2 '):return 'k2'
        if ti.startswith('к3 '):return 'k3'
        if 'alean к1' in ti or 'alean k1' in ti:return 'pk1'
        if 'alean к2' in ti or 'alean k2' in ti:return 'pk2'
        if 'alean к3' in ti or 'alean k3' in ti:return 'pk3'
        if ti.startswith('п1 '):return 'p1'
        if ti.startswith('п2 '):return 'p2'
    return None
konc_ids=set()
for t in tasks:
    c=classify(t)
    if c: t['wd']=DUR[c]
    if c=='konc': konc_ids.add(t['id'])
# Конкурс концепции: связь к ТЭП -> lag -25 (lead)
for ch in konc_ids:
    P[ch]=[(p,lt,-25) for (p,lt,lag) in P.get(ch,[])]
# Найти Экспертизу каждого объекта (7.X.1) и П2 (5.X.9)
exp_by_obj={}; p2_by_obj={}; obj5={}
for t in tasks:
    ti=(t['title'] or '').lower()
    if (t['oln'] or '').startswith('7.') and 'кспертиза проект' in ti: exp_by_obj[t['obj']]=t
    if ti.startswith('п2 '): p2_by_obj[t['obj']]=t
    if (t['oln'] or '').startswith('5.') and t['olv']==2: obj5[t['obj']]=t
# СОЗДАЁМ П3 для каждого объекта
maxuid=max((t['uid'] for t in tasks if t['uid']),default=1000)
p3_tasks=[]
for obj in HOTELS:
    exp=exp_by_obj.get(obj); o5=obj5.get(obj); p2=p2_by_obj.get(obj)
    if not exp or not o5: continue
    maxuid+=1
    # outline: после П2 в блоке объекта. П2=5.X.9 -> П3=5.X.10
    base=o5['oln']  # "5.Y"
    p3={'id':str(uuid.uuid4()),'uid':maxuid,'title':f'П3 Устранение замечаний экспертизы','oln':base+'.10','olv':3,
        'type':'schedule_task','obj':obj,'summary':False,'wd':None,'is_p3':True,
        'exp_id':exp['id'],'parent_oln':base}
    p3_tasks.append(p3)
    # связи П3: SS+10 и FF к экспертизе
    P[p3['id']]=[(exp['id'],'SS',10),(exp['id'],'FF',0)]
allt=tasks+p3_tasks
T={t['id']:t for t in allt}
# forward-pass
def recalc(t):
    sec=t['oln'].split('.')[0] if t['oln'] else ''
    ti=(t.get('title') or '').lower()
    # Изыскания (геология) — включаем в пересчёт, чтобы подхватили ранний К1
    is_geo=('геолог' in ti and ('полев' in ti or 'камеральн' in ti or 'формирование отчета' in ti)) and t['obj'] in HOTELS and t['id'] not in deleted
    return (sec in('5','6','7','8') and t['obj'] in HOTELS and t['id'] not in deleted and not t.get('summary')) or t.get('is_p3') or is_geo
calc=[t for t in allt if recalc(t)];cids={t['id'] for t in calc}
for t in calc:t['nds']=None;t['nde']=None
for t in allt:
    if t['id'] not in cids:t['nds']=t.get('ds');t['nde']=t.get('de')
chg=True;it=0
while chg and it<80:
    chg=False;it+=1
    for t in calc:
        starts=[];ends=[]
        for (p,lt,lag) in P.get(t['id'],[]):
            pt=T.get(p)
            if not pt or not pt.get('nde'): continue
            if lt=='FS': starts.append(bwd(next_wd(pt['nde']),-lag) if lag<0 else fwd(next_wd(pt['nde']),lag) if lag>0 else next_wd(pt['nde']))
            elif lt=='SS': starts.append(fwd(pt['nds'],lag) if lag>0 else bwd(pt['nds'],-lag) if lag<0 else pt['nds'])
            elif lt=='FF': ends.append(pt['nde'])
        if t.get('is_p3'):
            ns=max(starts) if starts else t.get('ds')
            ne=max(ends) if ends else (end_of(ns,t['wd'] or 1))
        else:
            ns=max(starts) if starts else t.get('ds')
            ne=end_of(ns,t['wd']) if t['wd'] and t['wd']>0 else ns
        if t['nds']!=ns or t['nde']!=ne:t['nds']=ns;t['nde']=ne;chg=True
# П3 длительность (производная) для записи
for t in p3_tasks:
    if t['nds'] and t['nde']:
        c=0;d=t['nds']
        while d<t['nde']: d=next_wd(d);c+=1
        t['wd']=c+1
kept=[t for t in allt if t['id'] not in deleted]
# summary агрегация
for lvl in (3,2,1):
    for t in kept:
        if t.get('olv')==lvl and t.get('summary'):
            ch=[x for x in kept if (x['oln'] or '').startswith((t['oln'] or '')+'.')]
            cs=[x['nds'] for x in ch if x.get('nds')];ce=[x['nde'] for x in ch if x.get('nde')]
            if cs:t['nds']=min(cs)
            if ce:t['nde']=max(ce)
idnew={t['id']:str(uuid.uuid4()) for t in kept}
olnmap={t['oln']:t['id'] for t in kept}
def parent_of(oln):
    if not oln or '.' not in oln:return None
    return olnmap.get('.'.join(oln.split('.')[:-1]))
def wbskey(o): return [int(x) for x in o.split('.')] if o else [999]
order=sorted([t for t in kept if t['oln']],key=lambda t:wbskey(t['oln']))
midmap={t['id']:i+1 for i,t in enumerate(order)}
NEWVER=str(uuid.uuid4())
def q(s): return 'NULL' if s is None else "'"+str(s).replace("'","''")+"'"
def qd(d): return 'NULL' if not d else "'"+d.strftime('%Y-%m-%d')+"'"
L=["BEGIN;"]
L.append("INSERT INTO schedule_imports (id,file_name,file_size,project_name,project_start_date,project_finish_date,object_field,mspdi_uid_max,tasks_total,tasks_inserted,tasks_updated,tasks_unmapped,predecessors_total,notes,imported_by_email,imported_at,object_field_id,extended_attribute_defs,project_calendar_settings,version_name,xml_content,is_active) SELECT "+q(NEWVER)+",file_name,file_size,project_name,project_start_date,project_finish_date,object_field,mspdi_uid_max,"+str(len(kept))+","+str(len(kept))+",0,0,0,'Общий график + изыскания (геология) пересчитаны от раннего К1',imported_by_email,now(),object_field_id,extended_attribute_defs,project_calendar_settings,'195 геология от К1',xml_content,false FROM schedule_imports WHERE id="+q(SRC)+";")
L.append("CREATE TEMP TABLE idm(old uuid,new uuid,ds date,de date,dur text,mid int,par uuid,oln text,olv int,ttl text,obj text,etype text,newtask bool);")
vals=[]
for t in kept:
    isnew=t.get('is_p3',False)
    dur=f"PT{(t['wd'] or 0)*8}H0M0S" if t.get('wd') else (t.get('dur') or 'PT0H0M0S')
    par=idnew.get(parent_of(t['oln'])) if parent_of(t['oln']) else None
    mid=midmap.get(t['id'])
    vals.append("("+q(t['id'] if not isnew else None)+","+q(idnew[t['id']])+","+qd(t['nds'])+","+qd(t['nde'])+","+q(dur)+","+(str(mid) if mid else 'NULL')+","+q(par)+","+q(t['oln'])+","+str(t['olv'] or 'NULL')+","+q(t.get('title'))+","+q(t.get('obj'))+","+q(t.get('type','schedule_task'))+","+('true' if isnew else 'false')+")")
for i in range(0,len(vals),80):
    L.append("INSERT INTO idm(old,new,ds,de,dur,mid,par,oln,olv,ttl,obj,etype,newtask) VALUES "+",".join(vals[i:i+80])+";")
# существующие — копия с трансформацией
L.append("INSERT INTO calendar_entries (id,entry_type,title,object_ids,date_mode,date_start,date_end,date_ref_entry_id,date_ref_from,date_ref_offset,date_ref_offset_type,date_computed,duration_note,exec_days,exec_type,is_manual,stage_name,stage_number,created_at,mspdi_uid,mspdi_id,outline_level,outline_number,parent_entry_id,is_summary,percent_complete,task_mode,is_project_wide,mspdi_notes,last_import_id,schedule_raw_text,title_original,contract_stage_id,mspdi_duration,schedule_version_id,mspdi_passthrough) SELECT m.new,ce.entry_type,ce.title,ce.object_ids,ce.date_mode,m.ds,m.de,NULL,ce.date_ref_from,ce.date_ref_offset,ce.date_ref_offset_type,m.ds,ce.duration_note,ce.exec_days,ce.exec_type,ce.is_manual,ce.stage_name,ce.stage_number,now(),ce.mspdi_uid,m.mid,m.olv,m.oln,m.par,ce.is_summary,ce.percent_complete,ce.task_mode,ce.is_project_wide,ce.mspdi_notes,"+q(NEWVER)+",ce.schedule_raw_text,ce.title_original,ce.contract_stage_id,m.dur,"+q(NEWVER)+",ce.mspdi_passthrough FROM idm m JOIN calendar_entries ce ON ce.id=m.old WHERE m.newtask=false;")
# новые П3
maxuid_sql=max((t['uid'] for t in p3_tasks),default=0)
L.append("INSERT INTO calendar_entries (id,entry_type,title,object_ids,date_mode,date_ref_offset,date_ref_offset_type,date_start,date_end,date_computed,is_manual,created_at,mspdi_uid,mspdi_id,outline_level,outline_number,parent_entry_id,is_summary,task_mode,is_project_wide,schedule_raw_text,mspdi_duration,schedule_version_id) SELECT m.new,m.etype,m.ttl,'{}','absolute',0,'calendar',m.ds,m.de,m.ds,true,now(),"+str(maxuid_sql+1000)+"+m.mid,m.mid,m.olv,m.oln,m.par,false,'manual',false,m.obj,m.dur,"+q(NEWVER)+" FROM idm m WHERE m.newtask=true;")
# предшественники
pv=[]
for ch,pl in P.items():
    if ch in deleted or ch not in idnew:continue
    for (p,lt,lag) in pl:
        if p in deleted or p not in idnew:continue
        pv.append("("+q(idnew[ch])+","+q(idnew[p])+","+q(lt)+","+str(lag)+",'working')")
for i in range(0,len(pv),80):
    L.append("INSERT INTO calendar_predecessors(calendar_id,predecessor_id,link_type,lag,lag_type) VALUES "+",".join(pv[i:i+80])+";")
L.append("COMMIT;")
open('/tmp/write_final.sql','w').write("\n".join(L))
print(f"FINAL: {len(kept)} задач (+{len(p3_tasks)} П3), {len(pv)} связей, версия {NEWVER}")
def find(obj,pr):
    for t in kept:
        if t.get('obj')==obj and pr((t.get('title') or '').lower()):return t
    return None
f=lambda t:t['nde'].strftime('%d.%m.%y') if t and t.get('nde') else '—'
for o in ['Отель 5* Family','Отель 3* Для персонала']:
    p2=find(o,lambda x:x.startswith('п2 ')); p3=find(o,lambda x:'устранение замечаний' in x)
    print(f"  {o}: П2={f(p2)} П3={p3['nds'].strftime('%d.%m.%y') if p3 and p3.get('nds') else '—'}->{f(p3)} ({p3['wd'] if p3 else '?'}рд)")

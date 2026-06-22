import json, re, uuid
from datetime import date, timedelta
tasks=json.load(open('/tmp/t2.json'))
preds_raw=json.load(open('/tmp/p2.json')) or []
SRC='3c024ce2-a08c-40dc-966d-95650dbfbddb'
def next_wd(d):
    d+=timedelta(days=1)
    while d.weekday()>=5: d+=timedelta(days=1)
    return d
def add_wd(s,n):
    if n<=0:return s
    d=s;c=1
    while c<n:d=next_wd(d);c+=1
    return d
def pdate(s):
    if not s:return None
    y,m,d=map(int,s[:10].split('-'));return date(y,m,d)
def wdur(pt):
    m=re.match(r'PT(\d+)H',pt or '');return int(m.group(1))//8 if m else 0
T={t['id']:t for t in tasks}
for t in tasks: t['ds']=pdate(t['ds']);t['de']=pdate(t['de']);t['wd']=wdur(t['dur'])
P={}
for r in preds_raw: P.setdefault(r['c'],[]).append(r['p'])
HOTELS={'Апарт-отель 3* (Космос/Спортивный)','Отель 3* Для персонала','Отель 4* Family (Солнышко)','Отель 5* Emerald','Отель 5* Family','Отель 5* Health','Отель 5* Select','Семейный отель 4* Residence'}
deleted={t['id'] for t in tasks if t['olv'] in (None,0)}
# Изменение: РНС -> 5 рабочих дней
for t in tasks:
    if (t['title'] or '').lower().startswith('получение разрешения на строительство'):
        t['wd']=5
def recalc(t):
    sec=t['oln'].split('.')[0] if t['oln'] else ''
    return sec in('5','6','7','8') and t['obj'] in HOTELS and t['id'] not in deleted and not t['summary']
calc=[t for t in tasks if recalc(t)];cids={t['id'] for t in calc}
for t in calc:t['nds']=None;t['nde']=None
for t in tasks:
    if t['id'] not in cids:t['nds']=t['ds'];t['nde']=t['de']
chg=True;it=0
while chg and it<60:
    chg=False;it+=1
    for t in calc:
        pe=[T[p]['nde'] for p in P.get(t['id'],[]) if p in T and T[p].get('nde')]
        ns=next_wd(max(pe)) if pe else t['ds']
        ne=add_wd(ns,t['wd']) if t['wd']>0 else ns
        if t['nds']!=ns or t['nde']!=ne:t['nds']=ns;t['nde']=ne;chg=True
kept=[t for t in tasks if t['id'] not in deleted]
for lvl in (3,2,1):
    for t in kept:
        if t['olv']==lvl and t['summary']:
            ch=[x for x in kept if (x['oln'] or '').startswith((t['oln'] or '')+'.')]
            cs=[x['nds'] for x in ch if x.get('nds')]; ce=[x['nde'] for x in ch if x.get('nde')]
            if cs:t['nds']=min(cs)
            if ce:t['nde']=max(ce)
idnew={t['id']:str(uuid.uuid4()) for t in kept}
olnmap={t['oln']:t['id'] for t in kept}
def parent_of(oln):
    if not oln or '.' not in oln:return None
    return olnmap.get('.'.join(oln.split('.')[:-1]))
def wbskey(o):
    return [int(x) for x in o.split('.')] if o else [999]
order=sorted([t for t in kept if t['oln']],key=lambda t:wbskey(t['oln']))
midmap={t['id']:i+1 for i,t in enumerate(order)}
NEWVER=str(uuid.uuid4())
def q(s):
    return 'NULL' if s is None else "'"+str(s).replace("'","''")+"'"
def qd(d):return 'NULL' if not d else "'"+d.strftime('%Y-%m-%d')+"'"
L=["BEGIN;"]
L.append("INSERT INTO schedule_imports (id,file_name,file_size,project_name,project_start_date,project_finish_date,object_field,mspdi_uid_max,tasks_total,tasks_inserted,tasks_updated,tasks_unmapped,predecessors_total,notes,imported_by_email,imported_at,object_field_id,extended_attribute_defs,project_calendar_settings,version_name,xml_content,is_active) SELECT "+q(NEWVER)+",file_name,file_size,project_name,project_start_date,project_finish_date,object_field,mspdi_uid_max,"+str(len(kept))+","+str(len(kept))+",0,0,0,'Сценарий: объединение + получение РНС сокращено до 5 дней',imported_by_email,now(),object_field_id,extended_attribute_defs,project_calendar_settings,'СОКРАЩЕННЫЙ ДО 30.09',xml_content,false FROM schedule_imports WHERE id="+q(SRC)+";")
L.append("CREATE TEMP TABLE idm(old uuid,new uuid,ds date,de date,dur text,mid int,par uuid);")
vals=[]
for t in kept:
    dur=f"PT{t['wd']*8}H0M0S" if t.get('wd') else (t['dur'] or 'PT0H0M0S')
    par=idnew.get(parent_of(t['oln'])) if parent_of(t['oln']) else None
    mid=midmap.get(t['id'])
    vals.append("("+q(t['id'])+","+q(idnew[t['id']])+","+qd(t['nds'])+","+qd(t['nde'])+","+q(dur)+","+(str(mid) if mid else 'NULL')+","+q(par)+")")
for i in range(0,len(vals),100):
    L.append("INSERT INTO idm(old,new,ds,de,dur,mid,par) VALUES "+",".join(vals[i:i+100])+";")
L.append("INSERT INTO calendar_entries (id,entry_type,title,object_ids,date_mode,date_start,date_end,date_ref_entry_id,date_ref_from,date_ref_offset,date_ref_offset_type,date_computed,duration_note,exec_days,exec_type,is_manual,stage_name,stage_number,created_at,mspdi_uid,mspdi_id,outline_level,outline_number,parent_entry_id,is_summary,percent_complete,task_mode,is_project_wide,mspdi_notes,last_import_id,schedule_raw_text,title_original,contract_stage_id,mspdi_duration,schedule_version_id,mspdi_passthrough) SELECT m.new,ce.entry_type,ce.title,ce.object_ids,ce.date_mode,m.ds,m.de,NULL,ce.date_ref_from,ce.date_ref_offset,ce.date_ref_offset_type,m.ds,ce.duration_note,ce.exec_days,ce.exec_type,ce.is_manual,ce.stage_name,ce.stage_number,now(),ce.mspdi_uid,m.mid,ce.outline_level,ce.outline_number,m.par,ce.is_summary,ce.percent_complete,ce.task_mode,ce.is_project_wide,ce.mspdi_notes,"+q(NEWVER)+",ce.schedule_raw_text,ce.title_original,ce.contract_stage_id,m.dur,"+q(NEWVER)+",ce.mspdi_passthrough FROM idm m JOIN calendar_entries ce ON ce.id=m.old;")
pv=[]
for ch,pl in P.items():
    if ch in deleted or ch not in idnew:continue
    for p in pl:
        if p in deleted or p not in idnew:continue
        pv.append("("+q(idnew[ch])+","+q(idnew[p])+",'FS',0,'working')")
for i in range(0,len(pv),100):
    L.append("INSERT INTO calendar_predecessors(calendar_id,predecessor_id,link_type,lag,lag_type) VALUES "+",".join(pv[i:i+100])+";")
L.append("COMMIT;")
open('/tmp/write_short.sql','w').write("\n".join(L))
print(f"SHORT SQL: {len(kept)} задач, {len(pv)} связей, версия {NEWVER}")
def find(obj,pr):
    for t in kept:
        if t['obj']==obj and pr((t['title'] or '').lower()):return t
    return None
f=lambda t:t['nde'].strftime('%d.%m.%y') if t and t.get('nde') else '—'
for o in ['Отель 5* Family','Отель 3* Для персонала']:
    print(f"  {o}: РНС =",f(find(o,lambda x:x.startswith('получение разрешения'))),"Точка выхода =",f(find(o,lambda x:x.startswith('точка выхода'))))

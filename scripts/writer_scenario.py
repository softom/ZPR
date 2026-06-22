import json, re, uuid
from datetime import date, timedelta
tasks=json.load(open('/tmp/tasks.json'))
preds_raw=json.load(open('/tmp/preds.json')) or []
SRC='6833cf91-032a-4bda-8b56-ceb3a2f73a88'
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
NEW={'konc':35,'k1':45,'pk1':40,'k2':45,'pk2':40,'k3':20,'pk3':10,'p1':35,'p2':70}
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
    if sec=='6':
        if 'онкурсная процедура на стади' in ti:return 'DEL'
        if ti.startswith('п1 '):return 'p1'
        if ti.startswith('п2 '):return 'p2'
        if ti.startswith('п3 '):return 'DEL'
    return None
HOTELS={'Апарт-отель 3* (Космос/Спортивный)','Отель 3* Для персонала','Отель 4* Family (Солнышко)','Отель 5* Emerald','Отель 5* Family','Отель 5* Health','Отель 5* Select','Семейный отель 4* Residence'}
deleted=set();cls={}
for t in tasks:
    c=classify(t);cls[t['id']]=c
    if c=='DEL':deleted.add(t['id'])
    elif c:t['wd']=NEW[c]
    sec=t['oln'].split('.')[0] if t['oln'] else ''
    if sec=='6' and t['summary']:deleted.add(t['id'])
for ch,pl in list(P.items()):
    np=[]
    for p in pl:
        if p in deleted:np+=[x for x in P.get(p,[]) if x not in deleted]
        else:np.append(p)
    P[ch]=list(dict.fromkeys(np))
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
for t in kept: t['noln']=t['oln']; t['nolv']=t['olv']; t['ntitle']=t['title']
maxc={}
for t in kept:
    if (t['oln'] or '').startswith('5.') and t['olv']==3:
        o=t['oln'].split('.'); maxc.setdefault(o[1],0); maxc[o[1]]=max(maxc[o[1]],int(o[2]))
obj5={}
for t in kept:
    if (t['oln'] or '').startswith('5.') and t['olv']==2: obj5[t['obj']]=t['oln']
for t in kept:
    if cls.get(t['id']) in ('p1','p2'):
        base=obj5.get(t['obj'])
        if base:
            y=base.split('.')[1]; maxc[y]+=1
            t['noln']=f"5.{y}.{maxc[y]}"; t['nolv']=3
for t in kept:
    if t['oln']=='5' and t['olv']==1: t['ntitle']='КОНЦЕПЦИЯ И ПРОЕКТ ОДИН ПОДРЯД'
for lvl in (3,2,1):
    for t in kept:
        if t['nolv']==lvl and t['summary']:
            ch=[x for x in kept if (x['noln'] or '').startswith((t['noln'] or '')+'.')]
            cs=[x['nds'] for x in ch if x.get('nds')]; ce=[x['nde'] for x in ch if x.get('nde')]
            if cs: t['nds']=min(cs)
            if ce: t['nde']=max(ce)
olnmap={t['noln']:t['id'] for t in kept}
idnew={t['id']:str(uuid.uuid4()) for t in kept}
def parent_of(oln):
    if not oln or '.' not in oln: return None
    return olnmap.get('.'.join(oln.split('.')[:-1]))
NEWVER=str(uuid.uuid4())
def q(s):
    if s is None:return 'NULL'
    return "'"+str(s).replace("'","''")+"'"
def qd(d):return 'NULL' if not d else "'"+d.strftime('%Y-%m-%d')+"'"
L=["BEGIN;"]
L.append("INSERT INTO schedule_imports (id,file_name,file_size,project_name,project_start_date,project_finish_date,object_field,mspdi_uid_max,tasks_total,tasks_inserted,tasks_updated,tasks_unmapped,predecessors_total,notes,imported_by_email,imported_at,object_field_id,extended_attribute_defs,project_calendar_settings,version_name,xml_content,is_active) SELECT "+q(NEWVER)+",file_name,file_size,project_name,project_start_date,project_finish_date,object_field,mspdi_uid_max,"+str(len(kept))+","+str(len(kept))+",0,0,0,'Сценарий: объединение Концепции и Проекта, нормативные сроки',imported_by_email,now(),object_field_id,extended_attribute_defs,project_calendar_settings,'КОНЦЕПЦИЯ И ПРОЕКТ ОДИН ПОДРЯД',xml_content,false FROM schedule_imports WHERE id="+q(SRC)+";")
L.append("CREATE TEMP TABLE idmap(old uuid,new uuid,ds date,de date,dur text,oln text,olv int,par uuid,ttl text);")
vals=[]
for t in kept:
    dur=f"PT{t['wd']*8}H0M0S" if t.get('wd') else (t['dur'] or 'PT0H0M0S')
    par=idnew.get(parent_of(t['noln'])) if parent_of(t['noln']) else None
    vals.append("("+q(t['id'])+","+q(idnew[t['id']])+","+qd(t['nds'])+","+qd(t['nde'])+","+q(dur)+","+q(t['noln'])+","+(str(t['nolv']) if t['nolv'] else 'NULL')+","+q(par)+","+q(t['ntitle'])+")")
for i in range(0,len(vals),100):
    L.append("INSERT INTO idmap(old,new,ds,de,dur,oln,olv,par,ttl) VALUES "+",".join(vals[i:i+100])+";")
L.append("INSERT INTO calendar_entries (id,entry_type,title,object_ids,date_mode,date_start,date_end,date_ref_entry_id,date_ref_from,date_ref_offset,date_ref_offset_type,date_computed,duration_note,exec_days,exec_type,is_manual,stage_name,stage_number,created_at,mspdi_uid,mspdi_id,outline_level,outline_number,parent_entry_id,is_summary,percent_complete,task_mode,is_project_wide,mspdi_notes,last_import_id,schedule_raw_text,title_original,contract_stage_id,mspdi_duration,schedule_version_id,mspdi_passthrough) SELECT m.new,ce.entry_type,m.ttl,ce.object_ids,ce.date_mode,m.ds,m.de,NULL,ce.date_ref_from,ce.date_ref_offset,ce.date_ref_offset_type,m.ds,ce.duration_note,ce.exec_days,ce.exec_type,ce.is_manual,ce.stage_name,ce.stage_number,now(),ce.mspdi_uid,ce.mspdi_id,m.olv,m.oln,m.par,ce.is_summary,ce.percent_complete,ce.task_mode,ce.is_project_wide,ce.mspdi_notes,"+q(NEWVER)+",ce.schedule_raw_text,ce.title_original,ce.contract_stage_id,m.dur,"+q(NEWVER)+",ce.mspdi_passthrough FROM idmap m JOIN calendar_entries ce ON ce.id=m.old;")
pv=[]
for ch,pl in P.items():
    if ch in deleted or ch not in idnew: continue
    for p in pl:
        if p in deleted or p not in idnew: continue
        pv.append("("+q(idnew[ch])+","+q(idnew[p])+",'FS',0,'working')")
for i in range(0,len(pv),100):
    L.append("INSERT INTO calendar_predecessors(calendar_id,predecessor_id,link_type,lag,lag_type) VALUES "+",".join(pv[i:i+100])+";")
L.append("COMMIT;")
open('/tmp/write.sql','w').write("\n".join(L))
print(f"SQL: {len(kept)} задач, {len(pv)} связей, удалено {len(deleted)}, версия {NEWVER}")

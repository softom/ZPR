-- Hybrid search: векторный поиск + keyword-boost + diversity-лимит на документ.
--
-- Зачем:
--   • "В каких договорах есть Массинг?" — векторная близость часто забирает
--     все слоты одним-двумя договорами, остальные (где тоже есть Массинг)
--     не попадают в top-K. LLM честно отвечает "только в одном", что неверно.
--
-- Решение:
--   1. keyword_terms — массив конкретных слов/фраз. Чанки, содержащие хоть одно,
--      получают boost 0.5 к similarity. Даёт приоритет именованным терминам.
--   2. per_doc_limit — не более N чанков с одного документа в top-K. Гарантирует
--      представительство разных документов.
--
-- Обратная совместимость: новые параметры — optional с дефолтами.
-- Старые вызовы search_documents(embedding, count) продолжают работать.

drop function if exists search_documents(vector, int, text[], text[], text[]);

create or replace function search_documents(
    query_embedding         vector(1536),
    match_count             int     default 10,
    filter_contractor_codes text[]  default null,
    filter_object_codes     text[]  default null,
    filter_doc_types        text[]  default null,
    keyword_terms           text[]  default null,
    per_doc_limit           int     default 3
)
returns table (
    document_id       uuid,
    chunk_text        text,
    similarity        float,
    title             text,
    folder_path       text,
    object_codes      jsonb,
    doc_type          text,
    version           text,
    contractor_name   text,
    contractor_codes  text[]
)
language sql stable as $$
    with filtered_docs as (
        select
            d.id,
            d.title,
            d.folder_path,
            d.object_codes,
            d.type,
            d.version,
            d.parties->'contractor'->>'name' as contractor_name,
            (
                select array_agg(distinct o.contractor)
                    filter (where o.contractor is not null)
                from objects o
                where d.object_codes ? o.code
            ) as contractor_codes_by_objects
        from documents d
        where d.deleted_at is null
          and (
              filter_contractor_codes is null
              or exists (
                  select 1 from objects o
                  where o.contractor = any(filter_contractor_codes)
                    and d.object_codes ? o.code
              )
              or (
                  d.parties->'contractor'->>'name' ilike any(
                      array(select '%' || c || '%' from unnest(filter_contractor_codes) c)
                  )
              )
          )
          and (
              filter_object_codes is null
              or d.object_codes ?| filter_object_codes
          )
          and (
              filter_doc_types is null
              or d.type::text = any(filter_doc_types)
          )
    ),
    scored as (
        select
            dc.document_id,
            dc.chunk_index,
            dc.chunk_text,
            fd.title,
            fd.folder_path,
            fd.object_codes,
            fd.type::text    as doc_type,
            fd.version,
            fd.contractor_name,
            fd.contractor_codes_by_objects as contractor_codes,
            -- Векторная близость (0..1, где 1 — идентичные векторы)
            (1 - (dc.embedding <=> query_embedding)) as vec_sim,
            -- Boost за keyword-совпадение: +0.5 если чанк содержит хотя бы один термин.
            -- Конкретное значение 0.5 выбрано так, чтобы keyword-матч гарантированно
            -- обгонял любой чанк без совпадения (разница в vec_sim обычно < 0.3).
            case
                when keyword_terms is null or array_length(keyword_terms, 1) is null then 0.0
                when exists (
                    select 1 from unnest(keyword_terms) t
                    where dc.chunk_text ilike '%' || t || '%'
                ) then 0.5
                else 0.0
            end as kw_boost
        from document_chunks dc
        join filtered_docs fd on fd.id = dc.document_id
    ),
    ranked as (
        select
            *,
            vec_sim + kw_boost as total_score,
            row_number() over (
                partition by document_id
                order by vec_sim + kw_boost desc
            ) as rn_in_doc
        from scored
    )
    select
        r.document_id,
        r.chunk_text,
        r.total_score  as similarity,
        r.title,
        r.folder_path,
        r.object_codes,
        r.doc_type,
        r.version,
        r.contractor_name,
        r.contractor_codes
    from ranked r
    where r.rn_in_doc <= per_doc_limit
    order by r.total_score desc
    limit match_count;
$$;

comment on function search_documents(vector, int, text[], text[], text[], text[], int) is
    'Hybrid RAG-поиск: векторная близость + keyword-boost + diversity-лимит на документ. Фильтры по подрядчикам/объектам/типам опциональны.';

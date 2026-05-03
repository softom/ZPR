-- Расширение search_documents параметрами фильтрации (entity-aware RAG).
-- Добавляем фильтры по подрядчикам, объектам и типам документов,
-- а также возвращаем обогащённые метаданные, чтобы LLM видела атрибуцию.
--
-- Обратная совместимость: 2-аргументные вызовы (/api/search) продолжают
-- работать — новые параметры имеют default NULL (без фильтрации).

drop function if exists search_documents(vector, int);
drop function if exists search_documents(vector(1536), int);

create or replace function search_documents(
    query_embedding         vector(1536),
    match_count             int     default 10,
    filter_contractor_codes text[]  default null,
    filter_object_codes     text[]  default null,
    filter_doc_types        text[]  default null
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
          -- Фильтр по подрядчику: либо по связанным объектам, либо по parties
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
          -- Фильтр по объектам: JSONB-массив содержит любой из запрошенных
          and (
              filter_object_codes is null
              or d.object_codes ?| filter_object_codes
          )
          -- Фильтр по типу документа (type — enum doc_type, приводим к тексту)
          and (
              filter_doc_types is null
              or d.type::text = any(filter_doc_types)
          )
    )
    select
        dc.document_id,
        dc.chunk_text,
        1 - (dc.embedding <=> query_embedding) as similarity,
        fd.title,
        fd.folder_path,
        fd.object_codes,
        fd.type::text    as doc_type,
        fd.version,
        fd.contractor_name,
        fd.contractor_codes_by_objects as contractor_codes
    from document_chunks dc
    join filtered_docs fd on fd.id = dc.document_id
    order by dc.embedding <=> query_embedding
    limit match_count;
$$;

comment on function search_documents(vector, int, text[], text[], text[]) is
    'Векторный поиск по чанкам документов с опциональными фильтрами по подрядчикам (коды из objects.contractor), объектам (коды objects.code) и типам документов. Возвращает чанки с обогащёнными метаданными для entity-aware RAG.';

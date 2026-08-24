begin;

alter table ai_provider_configs drop constraint if exists ai_provider_configs_provider_code_check;
alter table ai_provider_configs add constraint ai_provider_configs_provider_code_check
  check (provider_code in ('openai', 'google', 'anthropic', 'custom', 'codex'));

alter table ai_task_routing drop constraint if exists ai_task_routing_provider_code_check;
alter table ai_task_routing add constraint ai_task_routing_provider_code_check
  check (provider_code in ('openai', 'google', 'anthropic', 'custom', 'codex'));

insert into ai_provider_configs (
  provider_code, display_name, enabled,
  default_text_model, default_vision_model, default_image_model, capabilities
)
values (
  'codex', 'OpenAI Codex', true,
  'gpt-5.6-luna', 'gpt-5.6-luna', 'gpt-5.6-luna',
  '["text_generation","vision_analysis","image_generation","image_edit"]'::jsonb
)
on conflict (provider_code) do update
set display_name = excluded.display_name,
    default_text_model = coalesce(ai_provider_configs.default_text_model, excluded.default_text_model),
    default_vision_model = coalesce(ai_provider_configs.default_vision_model, excluded.default_vision_model),
    default_image_model = coalesce(ai_provider_configs.default_image_model, excluded.default_image_model),
    capabilities = excluded.capabilities,
    updated_at = now();

update ai_task_routing
set provider_code = 'codex',
    model = coalesce(model, 'gpt-5.6-luna'),
    updated_at = now()
where task_type = 'generated_image_review'
  and provider_code = 'anthropic';

commit;

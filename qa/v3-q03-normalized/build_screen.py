from pathlib import Path
import re,html
root=Path(__file__).resolve().parents[1]
input_html=Path('/mnt/data/q03_work/ГлюкоПапа_V3_Q03_GFNormalizedFacts_HTML_СОГЛАСОВАНИЕ_20261123.html').read_text('utf8')
assert input_html.count('<script>')==1 and input_html.count('</script>')==1
replaced=re.sub(r'<script>\s*\(function\(\)\{.*?</script>', '<script src="/q03/gf_normalized_facts_v3.js"></script>\n<script src="/q03/q03_readonly_screen.js"></script>',input_html,flags=re.S)
assert replaced!=input_html
replaced=replaced.replace('Пример одной ревизии хранилища: <span class="code">rev 42</span>. Реальные данные не загружены.','Данные загружаются из GFStorage, если профиль настроен.')
replaced=replaced.replace('<strong>6</strong><span>исходных событий','<strong>—</strong><span>исходных событий')
replaced=replaced.replace('<strong>3</strong><span>принятых факта','<strong>—</strong><span>принятых факта')
replaced=replaced.replace('<strong>3</strong><span>требуют внимания','<strong>—</strong><span>требуют внимания')
replaced=replaced.replace('Все 6 записей','Все записи')
replaced=replaced.replace('Эти данные вымышлены; действия редактирования отсутствуют.','Показаны данные только для чтения, без возможности редактирования.')
start=replaced.index('<section id="issues" hidden>')
end=replaced.index('</section>',start)+len('</section>')
block=replaced[start:end]
block=re.sub(r'(<div class="card"><h2>Неоднозначные данные</h2>).*?(</div><div class="callout">)',r'\1\2',block,flags=re.S)
# Remove three synthetic rows in a narrow span without changing design classes.
block=block.replace('2026-02-30 не преобразуется автоматически в март','Неверное время не исправляется автоматически')
replaced=replaced[:start]+block+replaced[end:]
assert 'const records=[' not in replaced
assert 'src="/q03/gf_normalized_facts_v3.js"' in replaced
assert 'src="/q03/q03_readonly_screen.js"' in replaced
(root/'js'/'q03_normalized_facts.html').write_text(replaced,encoding='utf8')
print('Q03_HTML_BUILD_PASS',len(replaced.encode('utf8')))

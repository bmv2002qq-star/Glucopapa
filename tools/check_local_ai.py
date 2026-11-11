from pathlib import Path
p=Path(__file__).resolve().parent.parent
html=(p/'app/src/main/assets/index.html').read_text(encoding='utf-8')
java=(p/'app/src/main/java/ru/family/glucodiary/LocalLlm.java').read_text(encoding='utf-8')
cpp=(p/'app/src/main/cpp/local_llm.cpp').read_text(encoding='utf-8')
assert 'gfLocalModelImport' in html and 'gfLocalModelAnalyze' in html
assert 'ACTION_OPEN_DOCUMENT' in (p/'app/src/main/java/ru/family/glucodiary/MainActivity.java').read_text(encoding='utf-8')
assert 'GGUF' in java and 'Не назначай и не рассчитывай инсулин' in java
assert 'llama_model_load_from_file' in cpp
assert 'nativeGenerate' in cpp and 'llama_process' in cpp
assert 'app/src/main/cpp' in str(p/'app/src/main/cpp')
print('Static local-AI integration checks passed')

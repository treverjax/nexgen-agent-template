// Provider and model selection state
let currentProvider = 'qwen-reasoning';
let selectedImageModel = 'auto';

// Toggle provider dropdown
function toggleProviderDropdown() {
    const dropdown = document.getElementById('provider-dropdown');
    dropdown.classList.toggle('hidden');
    
    // Close when clicking outside
    if (!dropdown.classList.contains('hidden')) {
        setTimeout(() => {
            document.addEventListener('click', function closeDropdown(e) {
                if (!e.target.closest('#provider-btn') && !e.target.closest('#provider-dropdown')) {
                    dropdown.classList.add('hidden');
                    document.removeEventListener('click', closeDropdown);
                }
            });
        }, 0);
    }
}

// Select provider
function selectProvider(provider) {
    currentProvider = provider;
    const label = document.getElementById('provider-label');
    const dropdown = document.getElementById('provider-dropdown');
    
    // Update label based on provider
    const providerNames = {
        'qwen-reasoning': 'Qwen 3 (Reasoning)',
        'qwen-fast': 'Qwen 2.5 (Fast)',
        'llama-70b': 'Llama 3.3 70B',
        'llama-405b': 'Llama 3.1 405B',
        'mistral-large': 'Mistral Large'
    };
    
    label.textContent = providerNames[provider] || 'Workers AI';
    dropdown.classList.add('hidden');
}

// Open image mode with model selector
function openImageMode() {
    setMode('image');
    // Show image model dropdown
    const dropdown = document.createElement('div');
    dropdown.id = 'image-model-dropdown';
    dropdown.className = 'absolute left-0 bottom-full mb-2 bg-white rounded-xl shadow-lg border border-gray-200 py-2 min-w-[280px] z-50';
    dropdown.innerHTML = `
        <div class="px-3 py-1 text-xs text-gray-400 font-semibold uppercase">Image Models</div>
        <button onclick="selectImageModel('auto')" class="w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center gap-2 text-sm">
            <span class="text-base">✨</span>
            <div><div class="font-medium text-gray-800">Auto</div><div class="text-xs text-gray-500">Best model for your prompt</div></div>
        </button>
        <button onclick="selectImageModel('flux-schnell')" class="w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center gap-2 text-sm">
            <span class="text-base">⚡</span>
            <div><div class="font-medium text-gray-800">FLUX Schnell</div><div class="text-xs text-gray-500">Fast, high-quality images</div></div>
        </button>
        <button onclick="selectImageModel('recraft-v3')" class="w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center gap-2 text-sm">
            <span class="text-base">🎨</span>
            <div><div class="font-medium text-gray-800">Recraft V3</div><div class="text-xs text-gray-500">Diagrams & illustrations</div></div>
        </button>
        <button onclick="selectImageModel('ideogram')" class="w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center gap-2 text-sm">
            <span class="text-base">🔤</span>
            <div><div class="font-medium text-gray-800">Ideogram</div><div class="text-xs text-gray-500">Text in images</div></div>
        </button>
        <button onclick="selectImageModel('stable-diffusion')" class="w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center gap-2 text-sm">
            <span class="text-base">🖼️</span>
            <div><div class="font-medium text-gray-800">Stable Diffusion XL</div><div class="text-xs text-gray-500">Versatile generation</div></div>
        </button>
    `;
    
    // Find the Create Image button and append dropdown
    const imageBtn = document.querySelector('button[onclick="openImageMode()"]');
    if (imageBtn && imageBtn.parentElement) {
        const container = imageBtn.parentElement;
        if (!container.querySelector('#image-model-dropdown')) {
            const wrapper = document.createElement('div');
            wrapper.className = 'relative';
            imageBtn.parentElement.insertBefore(wrapper, imageBtn);
            wrapper.appendChild(imageBtn);
            wrapper.appendChild(dropdown);
            
            // Auto-close after selection or click outside
            setTimeout(() => {
                document.addEventListener('click', function closeImageDropdown(e) {
                    if (!e.target.closest('#image-model-dropdown') && !e.target.closest('button[onclick="openImageMode()"]')) {
                        dropdown.remove();
                        document.removeEventListener('click', closeImageDropdown);
                    }
                });
            }, 0);
        }
    }
}

// Select image model
function selectImageModel(model) {
    selectedImageModel = model;
    const dropdown = document.getElementById('image-model-dropdown');
    if (dropdown) dropdown.remove();
    
    // Update placeholder
    const input = document.getElementById('q');
    input.placeholder = `Describe your image (${model === 'auto' ? 'Auto' : model})...`;
    input.focus();
}

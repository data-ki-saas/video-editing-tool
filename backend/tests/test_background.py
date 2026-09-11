from PIL import Image
from rembg import remove

# Load your local input image
input_path = "c:/Users/me/Downloads/istockphoto-643042252-170667a.jpg"
output_path = "c:/Users/me/Downloads/istockphoto-643042252-170667a_out.jpg"

input_image = Image.open(input_path)

# Remove background locally (runs on CPU or CUDA if available)
output_image = remove(input_image)

# Save with alpha transparency preserved
output_image.save(output_path)
print(f"Background removed successfully: {output_path}")
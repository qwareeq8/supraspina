function dartel_tissue_volumes(work, listfile, spmdir)
% Gray matter, white matter, and CSF volumes (liters) of every participant in
% listfile with the SPM Tissue Volumes utility (tmax 3, default mask
% tpm/mask_ICV.nii), which rebuilds the modulated warped classes from each
% seg8.mat. Their sum is the SPM total intracranial volume.
% -> <work>/tissue_volumes_spm_tvol.csv (columns File, Volume1-Volume3).
addpath(spmdir); spm('defaults', 'PET'); spm_jobman('initcfg'); spm_get_defaults('cmdline', true);
sids = strtrim(splitlines(fileread(listfile))); sids = sids(~cellfun(@isempty, sids));
mats = cellfun(@(s) fullfile(work, 'seg', s, [s '_T1w_seg8.mat']), sids, 'UniformOutput', false);
assert(all(cellfun(@(f) exist(f, 'file') == 2, mats)), 'seg8.mat files are missing');
matlabbatch{1}.spm.util.tvol.matfiles = mats;
matlabbatch{1}.spm.util.tvol.tmax = 3;
matlabbatch{1}.spm.util.tvol.mask = {fullfile(spmdir, 'tpm', 'mask_ICV.nii,1')};
matlabbatch{1}.spm.util.tvol.outf = fullfile(work, 'tissue_volumes_spm_tvol.csv');
spm_jobman('run', matlabbatch);
end
